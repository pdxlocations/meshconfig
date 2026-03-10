import { create, fromBinary, fromJson, toBinary, toJson } from "https://esm.sh/@bufbuild/protobuf@2.2.5";
import { MeshDevice, Protobuf } from "https://esm.sh/jsr/@meshtastic/core@2.6.6";
import yaml from "https://esm.sh/js-yaml@4.1.0";

function createToDeviceStream() {
  return new TransformStream({
    transform(chunk, controller) {
      const bufLen = chunk.length;
      const header = new Uint8Array([0x94, 0xc3, (bufLen >> 8) & 0xff, bufLen & 0xff]);
      controller.enqueue(new Uint8Array([...header, ...chunk]));
    },
  });
}

function createFromDeviceStream() {
  let byteBuffer = new Uint8Array([]);
  const textDecoder = new TextDecoder();

  return new TransformStream({
    transform(chunk, controller) {
      byteBuffer = new Uint8Array([...byteBuffer, ...chunk]);
      let exhausted = false;
      while (byteBuffer.length && !exhausted) {
        const framingIndex = byteBuffer.findIndex((byte) => byte === 0x94);
        const framingByte2 = byteBuffer[framingIndex + 1];
        if (framingByte2 !== 0xc3) {
          exhausted = true;
          continue;
        }

        if (byteBuffer.subarray(0, framingIndex).length) {
          controller.enqueue({
            type: "debug",
            data: textDecoder.decode(byteBuffer.subarray(0, framingIndex)),
          });
          byteBuffer = byteBuffer.subarray(framingIndex);
        }

        const msb = byteBuffer[2];
        const lsb = byteBuffer[3];
        const packetLength = msb !== undefined && lsb !== undefined ? (msb << 8) + lsb : null;
        if (packetLength == null || byteBuffer.length < 4 + packetLength) {
          exhausted = true;
          continue;
        }

        const packet = byteBuffer.subarray(4, 4 + packetLength);
        const malformedIndex = packet.findIndex((byte) => byte === 0x94);
        if (malformedIndex !== -1 && packet[malformedIndex + 1] === 0xc3) {
          byteBuffer = byteBuffer.subarray(malformedIndex);
          continue;
        }

        byteBuffer = byteBuffer.subarray(4 + packetLength);
        controller.enqueue({ type: "packet", data: packet });
      }
    },
  });
}

class WebSerialTransport {
  constructor(port) {
    if (!port.readable || !port.writable) {
      throw new Error("Serial stream not accessible");
    }

    this.port = port;
    this.abortController = new AbortController();

    const toDeviceStream = createToDeviceStream();
    this.pipePromise = toDeviceStream.readable.pipeTo(port.writable, {
      signal: this.abortController.signal,
    });
    this._toDevice = toDeviceStream.writable;
    this._fromDevice = port.readable.pipeThrough(createFromDeviceStream());
  }

  static async create(baudRate = 115200) {
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate });
    return new WebSerialTransport(port);
  }

  get toDevice() {
    return this._toDevice;
  }

  get fromDevice() {
    return this._fromDevice;
  }

  async disconnect() {
    try {
      this.abortController.abort();
      if (this.pipePromise) {
        try {
          await this.pipePromise;
        } catch (error) {
          if (!(error instanceof Error) || error.name !== "AbortError") {
            throw error;
          }
        }
      }
      await this.port.close();
    } catch (error) {
      log(`Serial disconnect warning: ${error?.message ?? error}`);
    }
  }
}

class WebBluetoothTransport {
  static ServiceUuid = "6ba1b218-15a8-461f-9fa8-5dcae273eafd";
  static ToRadioUuid = "f75c76d2-129e-4dad-a1dd-7866124401e7";
  static FromRadioUuid = "2c55e69e-4993-11ed-b878-0242ac120002";
  static FromNumUuid = "ed9da18c-a800-4f66-a670-aa7547e34453";

  static async create() {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [this.ServiceUuid] }],
    });
    return this.createFromDevice(device);
  }

  static async createFromDevice(device) {
    const gatt = await device.gatt?.connect();
    if (!gatt) {
      throw new Error("Failed to connect to GATT server");
    }

    const service = await gatt.getPrimaryService(this.ServiceUuid);
    const toRadioCharacteristic = await service.getCharacteristic(this.ToRadioUuid);
    const fromRadioCharacteristic = await service.getCharacteristic(this.FromRadioUuid);
    const fromNumCharacteristic = await service.getCharacteristic(this.FromNumUuid);

    return new WebBluetoothTransport(
      device,
      gatt,
      toRadioCharacteristic,
      fromRadioCharacteristic,
      fromNumCharacteristic,
    );
  }

  constructor(device, gatt, toRadioCharacteristic, fromRadioCharacteristic, fromNumCharacteristic) {
    this.device = device;
    this.gatt = gatt;
    this.toRadioCharacteristic = toRadioCharacteristic;
    this.fromRadioCharacteristic = fromRadioCharacteristic;
    this.fromNumCharacteristic = fromNumCharacteristic;
    this.controller = null;
    this.firstWrite = true;
    this.closed = false;

    this._fromDevice = new ReadableStream({
      start: (controller) => {
        this.controller = controller;
      },
    });

    this._toDevice = new WritableStream({
      write: async (chunk) => {
        await this.toRadioCharacteristic.writeValue(chunk);
        if (this.firstWrite && this.controller) {
          this.firstWrite = false;
          setTimeout(() => {
            this.readFromRadio(this.controller);
          }, 50);
        }
      },
    });

    this.onNotify = () => {
      if (this.controller && !this.closed) {
        this.readFromRadio(this.controller);
      }
    };
    this.fromNumCharacteristic.addEventListener("characteristicvaluechanged", this.onNotify);
    this.fromNumCharacteristic.startNotifications();
  }

  get toDevice() {
    return this._toDevice;
  }

  get fromDevice() {
    return this._fromDevice;
  }

  async readFromRadio(controller) {
    let hasMore = true;
    while (hasMore && !this.closed) {
      const value = await this.fromRadioCharacteristic.readValue();
      if (value.byteLength === 0) {
        hasMore = false;
        continue;
      }
      controller.enqueue({
        type: "packet",
        data: new Uint8Array(value.buffer),
      });
    }
  }

  async disconnect() {
    this.closed = true;
    try {
      this.fromNumCharacteristic.removeEventListener("characteristicvaluechanged", this.onNotify);
      await this.fromNumCharacteristic.stopNotifications();
    } catch {
      // Ignore notification teardown failures.
    }
    try {
      this.device.gatt?.disconnect();
    } catch {
      // Ignore disconnect failures.
    }
  }
}

class HttpTransport {
  static async create(address, tls = false) {
    const url = `${tls ? "https" : "http"}://${address}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch(`${url}/json/report`, {
        method: "GET",
        cache: "no-store",
        mode: "cors",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP reachability test failed with ${response.status}`);
      }
    } finally {
      clearTimeout(timeoutId);
    }
    return new HttpTransport(url);
  }

  constructor(url) {
    this.url = url;
    this.closed = false;
    this.fetchIntervalMs = 2500;
    this.readAbortController = new AbortController();

    this._toDevice = new WritableStream({
      write: async (chunk) => {
        await fetch(`${this.url}/api/v1/toradio`, {
          method: "PUT",
          headers: { "Content-Type": "application/x-protobuf" },
          body: chunk,
        });
      },
    });

    this._fromDevice = new ReadableStream({
      start: (controller) => {
        this.controller = controller;
        this.poll();
      },
    });
  }

  get toDevice() {
    return this._toDevice;
  }

  get fromDevice() {
    return this._fromDevice;
  }

  async poll() {
    while (!this.closed) {
      try {
        let readBuffer = new ArrayBuffer(1);
        while (!this.closed && readBuffer.byteLength > 0) {
          const response = await fetch(`${this.url}/api/v1/fromradio?all=false`, {
            method: "GET",
            headers: { Accept: "application/x-protobuf" },
            signal: this.readAbortController.signal,
          });
          readBuffer = await response.arrayBuffer();
          if (readBuffer.byteLength > 0) {
            this.controller?.enqueue({
              type: "packet",
              data: new Uint8Array(readBuffer),
            });
          }
        }
      } catch (error) {
        if (!this.closed) {
          log(`HTTP poll warning: ${error?.message ?? error}`);
        }
      }

      if (!this.closed) {
        await sleep(this.fetchIntervalMs);
      }
    }
  }

  async disconnect() {
    this.closed = true;
    this.readAbortController.abort();
  }
}

const CONFIG_TYPES = [
  ["device", Protobuf.Admin.AdminMessage_ConfigType.DEVICE_CONFIG],
  ["position", Protobuf.Admin.AdminMessage_ConfigType.POSITION_CONFIG],
  ["power", Protobuf.Admin.AdminMessage_ConfigType.POWER_CONFIG],
  ["network", Protobuf.Admin.AdminMessage_ConfigType.NETWORK_CONFIG],
  ["display", Protobuf.Admin.AdminMessage_ConfigType.DISPLAY_CONFIG],
  ["lora", Protobuf.Admin.AdminMessage_ConfigType.LORA_CONFIG],
  ["bluetooth", Protobuf.Admin.AdminMessage_ConfigType.BLUETOOTH_CONFIG],
  ["security", Protobuf.Admin.AdminMessage_ConfigType.SECURITY_CONFIG],
  ["deviceUi", Protobuf.Admin.AdminMessage_ConfigType.DEVICEUI_CONFIG],
];

const MODULE_CONFIG_TYPES = [
  ["mqtt", Protobuf.Admin.AdminMessage_ModuleConfigType.MQTT_CONFIG],
  ["serial", Protobuf.Admin.AdminMessage_ModuleConfigType.SERIAL_CONFIG],
  ["externalNotification", Protobuf.Admin.AdminMessage_ModuleConfigType.EXTNOTIF_CONFIG],
  ["storeForward", Protobuf.Admin.AdminMessage_ModuleConfigType.STOREFORWARD_CONFIG],
  ["rangeTest", Protobuf.Admin.AdminMessage_ModuleConfigType.RANGETEST_CONFIG],
  ["telemetry", Protobuf.Admin.AdminMessage_ModuleConfigType.TELEMETRY_CONFIG],
  ["cannedMessage", Protobuf.Admin.AdminMessage_ModuleConfigType.CANNEDMSG_CONFIG],
  ["audio", Protobuf.Admin.AdminMessage_ModuleConfigType.AUDIO_CONFIG],
  ["remoteHardware", Protobuf.Admin.AdminMessage_ModuleConfigType.REMOTEHARDWARE_CONFIG],
  ["neighborInfo", Protobuf.Admin.AdminMessage_ModuleConfigType.NEIGHBORINFO_CONFIG],
  ["ambientLighting", Protobuf.Admin.AdminMessage_ModuleConfigType.AMBIENTLIGHTING_CONFIG],
  ["detectionSensor", Protobuf.Admin.AdminMessage_ModuleConfigType.DETECTIONSENSOR_CONFIG],
  ["paxcounter", Protobuf.Admin.AdminMessage_ModuleConfigType.PAXCOUNTER_CONFIG],
  ["statusMessage", Protobuf.Admin.AdminMessage_ModuleConfigType.STATUSMESSAGE_CONFIG],
  ["trafficManagement", Protobuf.Admin.AdminMessage_ModuleConfigType.TRAFFICMANAGEMENT_CONFIG],
  ["tak", Protobuf.Admin.AdminMessage_ModuleConfigType.TAK_CONFIG],
];

const BOOLEAN_DEFAULT_PATHS = [
  ["config", "bluetooth", "enabled"],
  ["config", "lora", "sx126xRxBoostedGain"],
  ["config", "lora", "txEnabled"],
  ["config", "lora", "usePreset"],
  ["config", "position", "positionBroadcastSmartEnabled"],
  ["config", "security", "serialEnabled"],
  ["module_config", "mqtt", "encryptionEnabled"],
];

const MAX_CHANNELS = 8;
const CANNED_MESSAGES_MAX = 200;
const RINGTONE_MAX = 230;
const NODELESS_WANT_CONFIG_ID = 69420;
const CONFIGS_DIRECTORY = "./configs/";
const CONFIG_FILE_PATTERN = /\.(ya?ml|json)$/i;
const FALLBACK_CONFIG_PRESETS = [
  { id: "./configs/meshoregon.yaml", label: "MeshOregon", path: "./configs/meshoregon.yaml" },
];
const DEFAULT_PRESET_ID = "./configs/meshoregon.yaml";

const elements = {
  status: document.getElementById("status"),
  nodeSummary: document.getElementById("nodeSummary"),
  connectionType: document.getElementById("connectionType"),
  httpField: document.getElementById("httpField"),
  httpTarget: document.getElementById("httpTarget"),
  tlsToggle: document.getElementById("tlsToggle"),
  connectBtn: document.getElementById("connectBtn"),
  disconnectBtn: document.getElementById("disconnectBtn"),
  copyLiveBtn: document.getElementById("copyLiveBtn"),
  uploadBtn: document.getElementById("uploadBtn"),
  downloadLiveBtn: document.getElementById("downloadLiveBtn"),
  loadDesiredBtn: document.getElementById("loadDesiredBtn"),
  desiredFile: document.getElementById("desiredFile"),
  desiredPreset: document.getElementById("desiredPreset"),
  liveYaml: document.getElementById("liveYaml"),
  desiredYaml: document.getElementById("desiredYaml"),
  liveMeta: document.getElementById("liveMeta"),
  desiredMeta: document.getElementById("desiredMeta"),
  currentDiff: document.getElementById("currentDiff"),
  currentDiffBadge: document.getElementById("currentDiffBadge"),
  log: document.getElementById("log"),
  clearLogBtn: document.getElementById("clearLogBtn"),
};

const state = {
  device: null,
  transport: null,
  connected: false,
  deviceConfigured: false,
  liveSyncInProgress: false,
  myNodeNum: null,
  myNodeInfo: null,
  selfPosition: null,
  ownerMessage: null,
  sessionPasskey: null,
  metadata: null,
  cannedMessages: null,
  ringtone: null,
  configSections: {},
  moduleConfigSections: {},
  channelMap: new Map(),
  liveConfig: null,
  liveYaml: "",
  desiredConfig: null,
  configPresets: [],
  pendingAdminResponses: [],
  myNodeWaiters: [],
  configureWaiters: [],
  livePreviewTimer: null,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message) {
  const now = new Date().toLocaleTimeString();
  elements.log.textContent = `[${now}] ${message}\n${elements.log.textContent}`;
}

function presetLabelFromPath(path) {
  const filename = decodeURIComponent(path.split("/").pop() ?? path).replace(/\.[^.]+$/, "");
  if (filename.toLowerCase() === "meshoregon") {
    return "MeshOregon";
  }
  return filename.replace(/[_-]+/g, " ");
}

function comparePresetOrder(left, right) {
  if (left.id === DEFAULT_PRESET_ID) {
    return -1;
  }
  if (right.id === DEFAULT_PRESET_ID) {
    return 1;
  }
  return left.label.localeCompare(right.label);
}

function setPresetOptions(presets) {
  state.configPresets = presets.slice().sort(comparePresetOrder);
  elements.desiredPreset.innerHTML = "";

  for (const preset of state.configPresets) {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.label;
    elements.desiredPreset.append(option);
  }

  if (!state.configPresets.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No config presets found";
    elements.desiredPreset.append(option);
    elements.desiredPreset.disabled = true;
    return;
  }

  elements.desiredPreset.disabled = false;
  const defaultPreset = state.configPresets.find((entry) => entry.id === DEFAULT_PRESET_ID) ?? state.configPresets[0];
  elements.desiredPreset.value = defaultPreset.id;
}

async function discoverConfigPresets() {
  try {
    const response = await fetch(CONFIGS_DIRECTORY, {
      method: "GET",
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const presets = new Map();

    for (const anchor of doc.querySelectorAll("a[href]")) {
      const href = anchor.getAttribute("href")?.trim();
      if (!href || href === "../") {
        continue;
      }

      const url = new URL(href, new URL(CONFIGS_DIRECTORY, window.location.href));
      const filename = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      if (!CONFIG_FILE_PATTERN.test(filename)) {
        continue;
      }

      const path = `${CONFIGS_DIRECTORY}${filename}`;
      presets.set(path, {
        id: path,
        label: presetLabelFromPath(filename),
        path,
      });
    }

    if (presets.size) {
      return Array.from(presets.values());
    }
  } catch (error) {
    log(`Preset discovery fallback: ${error?.message ?? error}`);
  }

  return FALLBACK_CONFIG_PRESETS;
}

function setStatus(text, tone = "accent") {
  const palette = {
    accent: {
      background: "rgba(20, 75, 61, 0.10)",
      color: "#0b362c",
      border: "rgba(20, 75, 61, 0.16)",
    },
    success: {
      background: "rgba(20, 75, 61, 0.14)",
      color: "#0b362c",
      border: "rgba(20, 75, 61, 0.24)",
    },
    warn: {
      background: "rgba(157, 75, 26, 0.12)",
      color: "#7a360e",
      border: "rgba(157, 75, 26, 0.24)",
    },
    danger: {
      background: "rgba(141, 29, 47, 0.12)",
      color: "#7f1527",
      border: "rgba(141, 29, 47, 0.24)",
    },
  };
  const selected = palette[tone] ?? palette.accent;
  elements.status.textContent = text;
  elements.status.style.background = selected.background;
  elements.status.style.color = selected.color;
  elements.status.style.borderColor = selected.border;
}

function setControls() {
  elements.connectBtn.disabled = state.connected;
  elements.disconnectBtn.disabled = !state.connected;
  elements.copyLiveBtn.disabled = !state.liveConfig;
  elements.uploadBtn.disabled = !state.connected || !elements.desiredYaml.value.trim();
  elements.downloadLiveBtn.disabled = !state.liveConfig;
}

function updateConnectionFields() {
  const isHttp = elements.connectionType.value === "http";
  elements.httpField.style.display = isHttp ? "grid" : "none";
}

function formatNodeLabel() {
  if (!state.connected) {
    return "No node connected";
  }
  const owner = state.ownerMessage?.longName ?? "Unnamed node";
  const short = state.ownerMessage?.shortName ? ` (${state.ownerMessage.shortName})` : "";
  const nodeNum = state.myNodeNum != null ? ` · ${state.myNodeNum}` : "";
  return `${owner}${short}${nodeNum}`;
}

function updateNodeSummary() {
  elements.nodeSummary.textContent = formatNodeLabel();
}

function sanitizeByteStrings(value) {
  if (typeof value === "string" && value.startsWith("base64:")) {
    return value.slice(7);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeByteStrings(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeByteStrings(entry)]),
    );
  }
  return value;
}

function snakeToCamel(value) {
  return value.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
}

function normalizeKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeKeysDeep(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [snakeToCamel(key), normalizeKeysDeep(entry)]),
    );
  }
  return value;
}

function isObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function deepClone(value) {
  return value == null ? value : structuredClone(value);
}

function setPathIfMissing(root, path, fallback) {
  let cursor = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    if (!isObject(cursor[key])) {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  const leaf = path[path.length - 1];
  if (!(leaf in cursor)) {
    cursor[leaf] = fallback;
  }
}

function hasPath(root, path) {
  let cursor = root;
  for (const key of path) {
    if (!isObject(cursor) || !(key in cursor)) {
      return false;
    }
    cursor = cursor[key];
  }
  return true;
}

function normalizeExportDocument(documentValue, { applyBooleanDefaults = false } = {}) {
  const doc = deepClone(documentValue) ?? {};

  if (doc.ownerShort != null && doc.owner_short == null) {
    doc.owner_short = doc.ownerShort;
    delete doc.ownerShort;
  }
  if (doc.isLicensed != null && doc.is_licensed == null) {
    doc.is_licensed = doc.isLicensed;
    delete doc.isLicensed;
  }
  if (doc.isUnmessagable != null && doc.is_unmessagable == null) {
    doc.is_unmessagable = doc.isUnmessagable;
    delete doc.isUnmessagable;
  }
  if (doc.cannedMessages != null && doc.canned_messages == null) {
    doc.canned_messages = doc.cannedMessages;
    delete doc.cannedMessages;
  }
  if (doc.moduleConfig != null && doc.module_config == null) {
    doc.module_config = doc.moduleConfig;
    delete doc.moduleConfig;
  }

  if (doc.config) {
    doc.config = normalizeKeysDeep(sanitizeByteStrings(doc.config));
  }
  if (doc.module_config) {
    doc.module_config = normalizeKeysDeep(sanitizeByteStrings(doc.module_config));
  }
  if (Array.isArray(doc.channels)) {
    doc.channels = doc.channels.map((channel, index) => {
      const normalized = normalizeKeysDeep(sanitizeByteStrings(channel));
      if (normalized.index == null) {
        normalized.index = index;
      }
      return normalized;
    });
  }
  if (doc.location) {
    doc.location = normalizeKeysDeep(doc.location);
  }

  if (applyBooleanDefaults) {
    for (const path of BOOLEAN_DEFAULT_PATHS) {
      const parentPath = path.slice(0, -1);
      if (parentPath.length === 0 || hasPath(doc, parentPath)) {
        setPathIfMissing(doc, path, false);
      }
    }
  }

  return doc;
}

function dumpYaml(documentValue) {
  return yaml.dump(documentValue, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });
}

function parseDesiredYaml() {
  const source = elements.desiredYaml.value.trim();
  if (!source) {
    throw new Error("Desired YAML is empty.");
  }
  const parsed = yaml.load(source);
  if (!isObject(parsed)) {
    throw new Error("Desired YAML must parse to an object.");
  }
  return normalizeExportDocument(parsed, { applyBooleanDefaults: false });
}

function jsonMessage(schema, message) {
  return toJson(schema, message);
}

function locationFromPosition(position) {
  if (!position) {
    return null;
  }

  const lat = position.latitude ?? (position.latitudeI ? position.latitudeI / 1e7 : null);
  const lon = position.longitude ?? (position.longitudeI ? position.longitudeI / 1e7 : null);
  const alt = position.altitude ?? null;

  if (lat == null && lon == null && alt == null) {
    return null;
  }

  const location = {};
  if (lat != null) {
    location.lat = lat;
  }
  if (lon != null) {
    location.lon = lon;
  }
  if (alt != null) {
    location.alt = alt;
  }
  return location;
}

function describeConfigTime() {
  if (!state.liveConfig) {
    return "No download yet";
  }
  return `Last download ${new Date().toLocaleString()}`;
}

function setLiveConfig(config, metaText = describeConfigTime()) {
  state.liveConfig = config;
  state.liveYaml = dumpYaml(config);
  elements.liveYaml.value = state.liveYaml;
  elements.liveMeta.textContent = metaText;
  setControls();
}

function getSyncProgressSummary() {
  const configCount = Object.keys(state.configSections).length;
  const moduleCount = Object.keys(state.moduleConfigSections).length;
  const channelCount = state.channelMap.size;
  return `${configCount} config, ${moduleCount} module, ${channelCount} channel`;
}

function buildLiveConfigSnapshot() {
  const owner = state.ownerMessage ?? null;

  const config = {};
  for (const [name] of CONFIG_TYPES) {
    if (state.configSections[name] !== undefined) {
      config[name] = state.configSections[name];
    }
  }

  const moduleConfig = {};
  for (const [name] of MODULE_CONFIG_TYPES) {
    if (state.moduleConfigSections[name] !== undefined) {
      moduleConfig[name] = state.moduleConfigSections[name];
    }
  }

  const channels = [];
  for (let index = 0; index < MAX_CHANNELS; index += 1) {
    if (state.channelMap.has(index)) {
      channels.push(state.channelMap.get(index));
    }
  }

  return normalizeExportDocument({
    owner: owner?.longName ?? undefined,
    owner_short: owner?.shortName ?? undefined,
    is_licensed: owner?.isLicensed ?? undefined,
    is_unmessagable: owner?.isUnmessagable ?? undefined,
    location: locationFromPosition(state.selfPosition),
    config,
    module_config: moduleConfig,
    channels,
    canned_messages: state.cannedMessages ?? undefined,
    ringtone: state.ringtone ?? undefined,
  }, { applyBooleanDefaults: true });
}

function scheduleLivePreview() {
  if (!state.liveSyncInProgress) {
    return;
  }
  if (state.livePreviewTimer) {
    clearTimeout(state.livePreviewTimer);
  }
  state.livePreviewTimer = setTimeout(() => {
    state.livePreviewTimer = null;
    const snapshot = buildLiveConfigSnapshot();
    const hasAnyData =
      Object.keys(snapshot.config ?? {}).length ||
      Object.keys(snapshot.module_config ?? {}).length ||
      (snapshot.channels?.length ?? 0) ||
      snapshot.owner ||
      snapshot.location;

    if (!hasAnyData) {
      return;
    }

    setLiveConfig(snapshot, `Streaming live config… ${getSyncProgressSummary()}`);
  }, 120);
}

function setDesiredConfig(config, { preserveTextarea = false } = {}) {
  state.desiredConfig = config;
  if (!preserveTextarea) {
    elements.desiredYaml.value = dumpYaml(config);
  }
  elements.desiredMeta.textContent = config ? "Parsed and ready" : "Editable";
  setControls();
}

function applyLiveNamesToDesired(desired) {
  const longName = state.liveConfig?.owner ?? state.ownerMessage?.longName;
  const shortName = state.liveConfig?.owner_short ?? state.ownerMessage?.shortName;

  if (!longName && !shortName) {
    return desired;
  }

  if (longName) {
    desired.owner = longName;
  }
  if (shortName) {
    desired.owner_short = shortName;
  }

  return desired;
}

function syncDesiredNamesFromLive() {
  let desired = {};
  const source = elements.desiredYaml.value.trim();
  if (source) {
    try {
      desired = parseDesiredYaml();
    } catch (error) {
      log(`Skipped desired owner autofill: ${error?.message ?? error}`);
      return;
    }
  }

  setDesiredConfig(applyLiveNamesToDesired(desired));
  elements.desiredMeta.textContent = "Preset loaded with live node names";
  log("Filled desired config owner names from the downloaded node config.");
}

function getEffectiveDesiredConfig({ updateEditor = false } = {}) {
  const desired = applyLiveNamesToDesired(parseDesiredYaml());
  if (updateEditor) {
    setDesiredConfig(desired);
  } else {
    state.desiredConfig = desired;
  }
  return desired;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatDiffValue(value) {
  if (value === undefined) {
    return '<span class="diff-value diff-value--empty">missing</span>';
  }

  const pretty = typeof value === "string"
    ? JSON.stringify(value)
    : JSON.stringify(value, null, 2);
  return `<pre class="diff-value">${escapeHtml(pretty)}</pre>`;
}

function serializeDiffPart(value) {
  return value === undefined ? "__undefined__" : JSON.stringify(value);
}

function dedupeDiffChanges(changes) {
  const seen = new Set();
  const deduped = [];

  for (const change of changes) {
    const key = [
      change.kind,
      change.path,
      serializeDiffPart(change.actual),
      serializeDiffPart(change.desired),
    ].join("\u0000");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(change);
  }

  return deduped;
}

function renderDiff(target, badge, changes, idleText) {
  if (!changes) {
    target.textContent = idleText;
    badge.textContent = "No comparison yet";
    return;
  }

  const renderedChanges = dedupeDiffChanges(changes);

  if (!renderedChanges.length) {
    target.innerHTML = '<div class="diff-empty">No differences.</div>';
    badge.textContent = "In sync";
    return;
  }

  target.innerHTML = renderedChanges
    .map((change) => {
      const kindLabel = change.kind === "+" ? "Missing" : change.kind === "-" ? "Extra" : "Changed";
      const kindClass = change.kind === "+" ? "added" : change.kind === "-" ? "removed" : "changed";
      return `
        <section class="diff-entry">
          <div class="diff-entry__head">
            <span class="diff-kind diff-kind--${kindClass}">${kindLabel}</span>
            <code class="diff-path">${escapeHtml(change.path)}</code>
          </div>
          <div class="diff-entry__grid">
            <div class="diff-side">
              <div class="diff-label">Live</div>
              ${formatDiffValue(change.actual)}
            </div>
            <div class="diff-side">
              <div class="diff-label">Desired</div>
              ${formatDiffValue(change.desired)}
            </div>
          </div>
        </section>
      `;
    })
    .join("");
  badge.textContent = `${renderedChanges.length} change${renderedChanges.length === 1 ? "" : "s"}`;
}

function diffDesiredAgainstLive(actual, desired, path = "root", changes = []) {
  if (desired === undefined) {
    return changes;
  }

  if (Array.isArray(desired)) {
    if (JSON.stringify(actual) !== JSON.stringify(desired)) {
      changes.push({ kind: "~", path, actual, desired });
    }
    return changes;
  }

  if (isObject(desired)) {
    if (!isObject(actual)) {
      changes.push({ kind: "~", path, actual, desired });
      return changes;
    }
    for (const key of Object.keys(desired).sort()) {
      diffDesiredAgainstLive(actual[key], desired[key], path === "root" ? key : `${path}.${key}`, changes);
    }
    return changes;
  }

  if (actual !== desired) {
    const kind = actual === undefined ? "+" : "~";
    changes.push({ kind, path, actual, desired });
  }
  return changes;
}

function compareLiveAndDesired() {
  if (!state.liveConfig) {
    throw new Error("Download the live config first.");
  }
  const desired = getEffectiveDesiredConfig({ updateEditor: true });
  const changes = diffDesiredAgainstLive(
    normalizeExportDocument(state.liveConfig, { applyBooleanDefaults: true }),
    desired,
  );
  renderDiff(
    elements.currentDiff,
    elements.currentDiffBadge,
    changes,
    "Download the live config and compare it with your desired YAML.",
  );
  setControls();
  return desired;
}

function downloadText(filename, content) {
  const blob = new Blob([content], { type: "text/yaml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function loadDesiredConfigFromText(text, metaLabel) {
  elements.desiredYaml.value = text;
  const parsed = applyLiveNamesToDesired(parseDesiredYaml());
  setDesiredConfig(parsed);
  elements.desiredMeta.textContent = metaLabel;
  setControls();
}

async function autoCompareIfReady(reasonLabel) {
  if (!state.liveConfig) {
    return;
  }
  compareLiveAndDesired();
  log(`Auto-compared live config against ${reasonLabel}.`);
}

function tryAutoCompare(reasonLabel) {
  if (!state.liveConfig || !elements.desiredYaml.value.trim()) {
    return false;
  }

  try {
    compareLiveAndDesired();
    log(`Auto-compared live config against ${reasonLabel}.`);
    return true;
  } catch (error) {
    log(`Auto-compare skipped: ${error?.message ?? error}`);
    return false;
  }
}

async function loadPresetConfig(presetId, { autoCompare = true } = {}) {
  const preset = state.configPresets.find((entry) => entry.id === presetId);
  if (!preset) {
    throw new Error(`Unknown preset '${presetId}'.`);
  }

  const response = await fetch(preset.path, {
    method: "GET",
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const text = await response.text();
  await loadDesiredConfigFromText(text, `Loaded ${preset.label}`);
  log(`Loaded desired preset ${preset.label}.`);
  if (autoCompare) {
    await autoCompareIfReady(preset.label);
  }
}

function parseHttpTarget(input, tlsFlag) {
  let host = input.trim();
  let tls = tlsFlag;
  if (!host) {
    return null;
  }
  if (host.startsWith("http://")) {
    tls = false;
    host = host.replace(/^http:\/\//, "");
  } else if (host.startsWith("https://")) {
    tls = true;
    host = host.replace(/^https:\/\//, "");
  }
  if (host.includes("/")) {
    host = host.split("/")[0];
  }
  return { host, tls };
}

function resetConnectionState() {
  state.deviceConfigured = false;
  state.liveSyncInProgress = false;
  state.myNodeNum = null;
  state.myNodeInfo = null;
  state.selfPosition = null;
  state.ownerMessage = null;
  state.sessionPasskey = null;
  state.metadata = null;
  state.cannedMessages = null;
  state.ringtone = null;
  state.configSections = {};
  state.moduleConfigSections = {};
  state.channelMap = new Map();
  state.pendingAdminResponses = [];
  state.myNodeWaiters = [];
  state.configureWaiters = [];
  if (state.livePreviewTimer) {
    clearTimeout(state.livePreviewTimer);
    state.livePreviewTimer = null;
  }
  updateNodeSummary();
}

function attachDeviceHandlers(device) {
  device.events.onLogEvent.subscribe((entry) => {
    if (entry.message) {
      log(`Device: ${entry.message}`);
    }
  });

  device.events.onMyNodeInfo.subscribe((info) => {
    state.myNodeInfo = info;
    state.myNodeNum = info.myNodeNum;
    updateNodeSummary();
    resolveMyNodeWaiters();
  });

  device.events.onDeviceStatus.subscribe((status) => {
    state.deviceConfigured = status === 7;
    if (status === 7) {
      resolveConfigureWaiters();
    }
  });

  device.events.onUserPacket.subscribe((packet) => {
    if (packet.from === state.myNodeNum || packet.from === packet.to) {
      state.ownerMessage = jsonMessage(Protobuf.Mesh.UserSchema, packet.data);
      updateNodeSummary();
      scheduleLivePreview();
    }
  });

  device.events.onPositionPacket.subscribe((packet) => {
    if (packet.from === state.myNodeNum) {
      state.selfPosition = jsonMessage(Protobuf.Mesh.PositionSchema, packet.data);
      scheduleLivePreview();
    }
  });

  device.events.onConfigPacket.subscribe((config) => {
    const json = jsonMessage(Protobuf.Config.ConfigSchema, config);
    const variant = config.payloadVariant.case;
    if (variant) {
      state.configSections[variant] = json[variant];
      log(`Received config.${variant}`);
      scheduleLivePreview();
    }
  });

  device.events.onModuleConfigPacket.subscribe((moduleConfig) => {
    const json = jsonMessage(Protobuf.ModuleConfig.ModuleConfigSchema, moduleConfig);
    const variant = moduleConfig.payloadVariant.case;
    if (variant) {
      state.moduleConfigSections[variant] = json[variant];
      log(`Received module_config.${variant}`);
      scheduleLivePreview();
    }
  });

  device.events.onChannelPacket.subscribe((channel) => {
    const json = jsonMessage(Protobuf.Channel.ChannelSchema, channel);
    state.channelMap.set(channel.index, json);
    log(`Received channel ${channel.index}`);
    scheduleLivePreview();
  });

  device.events.onMeshPacket.subscribe((meshPacket) => {
    const decoded = meshPacket.payloadVariant.case === "decoded" ? meshPacket.payloadVariant.value : null;
    if (!decoded || decoded.portnum !== Protobuf.Portnums.PortNum.ADMIN_APP) {
      return;
    }

    const adminMessage = fromBinary(Protobuf.Admin.AdminMessageSchema, decoded.payload);
    if (adminMessage.sessionPasskey?.length) {
      state.sessionPasskey = adminMessage.sessionPasskey;
    }
    resolvePendingAdminResponses(adminMessage);
  });
}

function resolvePendingAdminResponses(adminMessage) {
  const remaining = [];
  for (const pending of state.pendingAdminResponses) {
    if (pending.matcher(adminMessage)) {
      clearTimeout(pending.timeoutId);
      pending.resolve(adminMessage);
    } else {
      remaining.push(pending);
    }
  }
  state.pendingAdminResponses = remaining;
}

function waitForAdminResponse(matcher, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      state.pendingAdminResponses = state.pendingAdminResponses.filter((pending) => pending.timeoutId !== timeoutId);
      reject(new Error("Timed out waiting for admin response."));
    }, timeoutMs);

    state.pendingAdminResponses.push({ matcher, resolve, timeoutId });
  });
}

function resolveMyNodeWaiters() {
  if (state.myNodeNum == null) {
    return;
  }
  for (const resolve of state.myNodeWaiters.splice(0)) {
    resolve();
  }
}

function resolveConfigureWaiters() {
  for (const resolve of state.configureWaiters.splice(0)) {
    resolve();
  }
}

async function waitForMyNodeInfo(timeoutMs = 5000) {
  if (state.myNodeNum != null) {
    return;
  }

  await new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      state.myNodeWaiters = state.myNodeWaiters.filter((entry) => entry !== onResolve);
      reject(new Error("Timed out waiting for node identity."));
    }, timeoutMs);

    const onResolve = () => {
      clearTimeout(timeoutId);
      resolve();
    };
    state.myNodeWaiters.push(onResolve);
  });
}

async function waitForConfigured(timeoutMs = 12000) {
  if (state.deviceConfigured) {
    return;
  }

  await new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      state.configureWaiters = state.configureWaiters.filter((entry) => entry !== onResolve);
      reject(new Error("Timed out waiting for configure() to complete."));
    }, timeoutMs);

    const onResolve = () => {
      clearTimeout(timeoutId);
      resolve();
    };
    state.configureWaiters.push(onResolve);
  });
}

async function sendAdmin(payloadVariant, { includeSessionPasskey = false, wantResponse = true } = {}) {
  if (!state.device) {
    throw new Error("No connected device.");
  }

  const adminMessage = create(Protobuf.Admin.AdminMessageSchema, {
    payloadVariant,
    sessionPasskey: includeSessionPasskey && state.sessionPasskey ? state.sessionPasskey : undefined,
  });

  return state.device.sendPacket(
    toBinary(Protobuf.Admin.AdminMessageSchema, adminMessage),
    Protobuf.Portnums.PortNum.ADMIN_APP,
    "self",
    undefined,
    true,
    wantResponse,
  );
}

async function requestAdmin(payloadVariant, matcher, timeoutMs = 5000) {
  const responsePromise = waitForAdminResponse(matcher, timeoutMs);
  await sendAdmin(payloadVariant, { wantResponse: true });
  return responsePromise;
}

async function ensureSessionPasskey() {
  if (state.sessionPasskey?.length) {
    return;
  }

  await requestAdmin(
    {
      case: "getConfigRequest",
      value: Protobuf.Admin.AdminMessage_ConfigType.SESSIONKEY_CONFIG,
    },
    (adminMessage) =>
      adminMessage.payloadVariant.case === "getConfigResponse" &&
      adminMessage.payloadVariant.value.payloadVariant.case === "sessionkey",
  );

  if (!state.sessionPasskey?.length) {
    throw new Error("Node did not return an admin session passkey.");
  }
}

async function requestOwner() {
  const adminMessage = await requestAdmin(
    { case: "getOwnerRequest", value: true },
    (response) => response.payloadVariant.case === "getOwnerResponse",
  );
  return jsonMessage(Protobuf.Mesh.UserSchema, adminMessage.payloadVariant.value);
}

async function requestMetadata() {
  const adminMessage = await requestAdmin(
    { case: "getDeviceMetadataRequest", value: true },
    (response) => response.payloadVariant.case === "getDeviceMetadataResponse",
  );
  return jsonMessage(Protobuf.Mesh.DeviceMetadataSchema, adminMessage.payloadVariant.value);
}

async function requestConfigSection(name, enumValue) {
  const adminMessage = await requestAdmin(
    { case: "getConfigRequest", value: enumValue },
    (response) =>
      response.payloadVariant.case === "getConfigResponse" &&
      response.payloadVariant.value.payloadVariant.case === name,
  );
  const json = jsonMessage(Protobuf.Config.ConfigSchema, adminMessage.payloadVariant.value);
  return json[name];
}

async function requestModuleConfigSection(name, enumValue) {
  const adminMessage = await requestAdmin(
    { case: "getModuleConfigRequest", value: enumValue },
    (response) =>
      response.payloadVariant.case === "getModuleConfigResponse" &&
      response.payloadVariant.value.payloadVariant.case === name,
  );
  const json = jsonMessage(Protobuf.ModuleConfig.ModuleConfigSchema, adminMessage.payloadVariant.value);
  return json[name];
}

async function requestChannel(index) {
  const adminMessage = await requestAdmin(
    { case: "getChannelRequest", value: index + 1 },
    (response) =>
      response.payloadVariant.case === "getChannelResponse" &&
      response.payloadVariant.value.index === index,
  );
  return jsonMessage(Protobuf.Channel.ChannelSchema, adminMessage.payloadVariant.value);
}

async function requestCannedMessages() {
  try {
    const adminMessage = await requestAdmin(
      { case: "getCannedMessageModuleMessagesRequest", value: true },
      (response) => response.payloadVariant.case === "getCannedMessageModuleMessagesResponse",
      3000,
    );
    state.cannedMessages = adminMessage.payloadVariant.value || null;
    scheduleLivePreview();
    return state.cannedMessages;
  } catch {
    return null;
  }
}

async function requestRingtone() {
  try {
    const adminMessage = await requestAdmin(
      { case: "getRingtoneRequest", value: true },
      (response) => response.payloadVariant.case === "getRingtoneResponse",
      3000,
    );
    state.ringtone = adminMessage.payloadVariant.value || null;
    scheduleLivePreview();
    return state.ringtone;
  } catch {
    return null;
  }
}

async function downloadLiveConfig() {
  if (!state.connected || !state.device) {
    throw new Error("Connect to a node first.");
  }

  setStatus("Syncing live config", "warn");
  log("Requesting fresh configure sync from node.");
  await waitForMyNodeInfo();
  state.deviceConfigured = false;
  state.liveSyncInProgress = true;
  state.cannedMessages = null;
  state.ringtone = null;
  state.configSections = {};
  state.moduleConfigSections = {};
  state.channelMap = new Map();
  elements.liveYaml.value = "Waiting for config packets from the node…";
  elements.liveMeta.textContent = "Starting sync…";
  state.device.configure().catch((error) => {
    log(`Configure request warning: ${error?.message ?? error}`);
  });
  await waitForConfigured();
  log("Configure sync completed. Rendering core config immediately.");
  setLiveConfig(buildLiveConfigSnapshot(), `Core config loaded. ${getSyncProgressSummary()}`);
  syncDesiredNamesFromLive();
  tryAutoCompare("the selected desired config");
  log("Requesting optional canned messages and ringtone.");

  await Promise.allSettled([requestCannedMessages(), requestRingtone()]);
  const liveConfig = buildLiveConfigSnapshot();

  state.liveSyncInProgress = false;
  if (state.livePreviewTimer) {
    clearTimeout(state.livePreviewTimer);
    state.livePreviewTimer = null;
  }
  setLiveConfig(liveConfig, describeConfigTime());
  syncDesiredNamesFromLive();
  tryAutoCompare("the finalized live config");
  updateNodeSummary();
  setStatus("Connected", "success");
  log("Live config download complete.");
  return liveConfig;
}

function toProtoMessage(schema, value) {
  return fromJson(schema, sanitizeByteStrings(value));
}

async function writeOwner(desired) {
  if (
    desired.owner == null &&
    desired.owner_short == null &&
    desired.is_licensed == null &&
    desired.is_unmessagable == null
  ) {
    return;
  }

  const ownerMessage = create(Protobuf.Mesh.UserSchema, {
    longName: desired.owner ?? undefined,
    shortName: desired.owner_short ?? undefined,
    isLicensed: desired.is_licensed ?? undefined,
    isUnmessagable: desired.is_unmessagable ?? undefined,
  });

  await sendAdmin(
    {
      case: "setOwner",
      value: ownerMessage,
    },
    { includeSessionPasskey: true },
  );
}

async function writeLocation(location) {
  if (!location) {
    return;
  }

  const lat = Number(location.lat ?? 0);
  const lon = Number(location.lon ?? 0);
  const alt = Number(location.alt ?? 0);
  const position = create(Protobuf.Mesh.PositionSchema, {
    latitudeI: lat ? Math.trunc(lat * 1e7) : undefined,
    longitudeI: lon ? Math.trunc(lon * 1e7) : undefined,
    altitude: alt || undefined,
  });

  await sendAdmin(
    {
      case: "setFixedPosition",
      value: position,
    },
    { includeSessionPasskey: true },
  );
}

async function writeConfigTree(config) {
  if (!isObject(config)) {
    return;
  }

  for (const [sectionName, sectionValue] of Object.entries(config)) {
    const message = toProtoMessage(Protobuf.Config.ConfigSchema, { [sectionName]: sectionValue });
    await sendAdmin(
      {
        case: "setConfig",
        value: message,
      },
      { includeSessionPasskey: true },
    );
    log(`Wrote config.${sectionName}`);
  }
}

async function writeModuleConfigTree(moduleConfig) {
  if (!isObject(moduleConfig)) {
    return;
  }

  for (const [sectionName, sectionValue] of Object.entries(moduleConfig)) {
    const message = toProtoMessage(Protobuf.ModuleConfig.ModuleConfigSchema, {
      [sectionName]: sectionValue,
    });
    await sendAdmin(
      {
        case: "setModuleConfig",
        value: message,
      },
      { includeSessionPasskey: true },
    );
    log(`Wrote module_config.${sectionName}`);
  }
}

async function writeChannels(channels) {
  if (!Array.isArray(channels)) {
    return;
  }

  for (let index = 0; index < channels.length; index += 1) {
    const channel = { ...channels[index], index: channels[index].index ?? index };
    const message = toProtoMessage(Protobuf.Channel.ChannelSchema, channel);
    await sendAdmin(
      {
        case: "setChannel",
        value: message,
      },
      { includeSessionPasskey: true },
    );
    log(`Wrote channel ${channel.index}`);
  }
}

async function writeCannedMessages(value) {
  if (value == null || value === "") {
    return;
  }
  if (value.length > CANNED_MESSAGES_MAX) {
    throw new Error(`Canned messages exceed ${CANNED_MESSAGES_MAX} characters.`);
  }
  await sendAdmin(
    {
      case: "setCannedMessageModuleMessages",
      value,
    },
    { includeSessionPasskey: true },
  );
}

async function writeRingtone(value) {
  if (value == null || value === "") {
    return;
  }
  if (value.length > RINGTONE_MAX) {
    throw new Error(`Ringtone exceeds ${RINGTONE_MAX} characters.`);
  }
  await sendAdmin(
    {
      case: "setRingtoneMessage",
      value,
    },
    { includeSessionPasskey: true },
  );
}

async function uploadDesiredConfig() {
  if (!state.connected) {
    throw new Error("Connect to a node first.");
  }

  const desired = getEffectiveDesiredConfig({ updateEditor: true });

  setStatus("Uploading config", "warn");
  log("Beginning settings transaction.");
  await waitForMyNodeInfo();
  await ensureSessionPasskey();

  await sendAdmin(
    {
      case: "beginEditSettings",
      value: true,
    },
    { includeSessionPasskey: true },
  );

  try {
    await writeOwner(desired);
    await writeLocation(desired.location);
    await writeConfigTree(desired.config);
    await writeModuleConfigTree(desired.module_config);
    await writeChannels(desired.channels);
    await writeCannedMessages(desired.canned_messages);
    await writeRingtone(desired.ringtone);

    await sendAdmin(
      {
        case: "commitEditSettings",
        value: true,
      },
      { includeSessionPasskey: true },
    );
    log("Committed settings transaction.");
  } catch (error) {
    log(`Upload failed before commit: ${error?.message ?? error}`);
    throw error;
  }

  setStatus("Connected", "success");
  log("Upload complete.");
}

async function connect() {
  try {
    setStatus("Connecting", "warn");
    resetConnectionState();
    let transport;

    if (elements.connectionType.value === "serial") {
      if (!("serial" in navigator)) {
        throw new Error("Web Serial is unavailable in this browser.");
      }
      if (!window.isSecureContext) {
        throw new Error("Web Serial requires HTTPS or localhost.");
      }
      transport = await WebSerialTransport.create();
      log("Using Web Serial transport.");
    } else if (elements.connectionType.value === "bluetooth") {
      if (!("bluetooth" in navigator)) {
        throw new Error("Web Bluetooth is unavailable in this browser.");
      }
      if (!window.isSecureContext) {
        throw new Error("Web Bluetooth requires HTTPS or localhost.");
      }
      transport = await WebBluetoothTransport.create();
      log("Using Web Bluetooth transport.");
    } else {
      const target = parseHttpTarget(elements.httpTarget.value, elements.tlsToggle.checked);
      if (!target?.host) {
        throw new Error("HTTP connection requires a host or IP.");
      }
      transport = await HttpTransport.create(target.host, target.tls);
      log(`Using HTTP transport ${target.tls ? "https" : "http"}://${target.host}`);
    }

    const device = new MeshDevice(transport, NODELESS_WANT_CONFIG_ID);
    attachDeviceHandlers(device);

    state.transport = transport;
    state.device = device;
    state.connected = true;
    updateNodeSummary();
    setControls();

    log("Requesting initial node handshake without NodeDB download.");
    device.configure().catch((error) => {
      log(`Initial configure warning: ${error?.message ?? error}`);
    });
    await waitForMyNodeInfo();
    setStatus("Syncing live config", "warn");
    log("Node identity received. Starting automatic live config sync.");
    await downloadLiveConfig();
  } catch (error) {
    state.transport = null;
    state.device = null;
    state.connected = false;
    setControls();
    setStatus("Connection failed", "danger");
    log(`Connect error: ${error?.message ?? error}`);
    throw error;
  }
}

async function disconnect() {
  if (!state.transport && !state.device) {
    return;
  }

  setStatus("Disconnecting", "warn");
  try {
    await state.transport?.disconnect?.();
  } catch (error) {
    log(`Disconnect warning: ${error?.message ?? error}`);
  } finally {
    state.transport = null;
    state.device = null;
    state.connected = false;
    resetConnectionState();
    setStatus("Disconnected", "accent");
    setControls();
    log("Disconnected.");
  }
}

async function withTask(task) {
  try {
    await task();
  } catch (error) {
    setStatus("Action failed", "danger");
    log(`Error: ${error?.message ?? error}`);
    console.error(error);
  } finally {
    setControls();
  }
}

updateConnectionFields();
updateNodeSummary();
setControls();
log("App ready. Choose a transport and connect to a node.");
if (window.location.protocol === "file:") {
  setStatus("Serve over localhost", "warn");
  log("Open this app from a local web server such as http://localhost:8420, not directly as file://.");
} else {
  discoverConfigPresets()
    .then((presets) => {
      setPresetOptions(presets);
      if (!state.configPresets.length) {
        return;
      }
      return loadPresetConfig(elements.desiredPreset.value, { autoCompare: false });
    })
    .catch((error) => {
      log(`Default desired config not loaded: ${error?.message ?? error}`);
    });
}

elements.connectionType.addEventListener("change", updateConnectionFields);
elements.desiredPreset?.addEventListener("change", () =>
  withTask(async () => {
    await loadPresetConfig(elements.desiredPreset.value, { autoCompare: true });
  }),
);
elements.connectBtn.addEventListener("click", () => withTask(connect));
elements.disconnectBtn.addEventListener("click", () => withTask(disconnect));
elements.copyLiveBtn.addEventListener("click", () => {
  if (!state.liveConfig) {
    return;
  }
  setDesiredConfig(state.liveConfig);
  renderDiff(
    elements.currentDiff,
    elements.currentDiffBadge,
    [],
    "Download the live config and compare it with your desired YAML.",
  );
});
elements.uploadBtn.addEventListener("click", () =>
  withTask(async () => {
    compareLiveAndDesired();
    await uploadDesiredConfig();
  }),
);
elements.downloadLiveBtn.addEventListener("click", () => {
  if (!state.liveYaml) {
    return;
  }
  downloadText("meshtastic-live-config.yaml", state.liveYaml);
});
elements.loadDesiredBtn.addEventListener("click", () => elements.desiredFile.click());
elements.desiredFile.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }
  const text = await file.text();
  await loadDesiredConfigFromText(text, `Loaded ${file.name}`);
  await autoCompareIfReady(file.name);
  event.target.value = "";
});
elements.desiredYaml.addEventListener("input", () => {
  elements.desiredMeta.textContent = "Edited locally";
  setControls();
});
elements.clearLogBtn.addEventListener("click", () => {
  elements.log.textContent = "";
});
