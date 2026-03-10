# MeshConfig Workbench

Static web app for direct Meshtastic config work:

- connect over USB serial, Web Bluetooth, or HTTP(S)
- download the node's writable config as YAML
- compare live config to a desired YAML document
- upload the desired config back to the node

## References used

- `https://github.com/pdxlocations/nodesnoop`
  - browser transport patterns for Web Serial and HTTP/BLE connection flow
- `https://github.com/meshtastic/js`
  - `MeshDevice` admin/config packet APIs
- `https://github.com/meshtastic/python`
  - `--export-config` structure and configure transaction order

## Run locally

Serve this directory from a static web server:

```sh
python3 -m http.server 8420
```

Then open:

```text
http://localhost:8420
```

## Notes

- Web Serial and Web Bluetooth require a Chromium-based browser and a secure context.
- The exported YAML is intentionally focused on writable settings. It excludes transient admin session data.
- The app accepts YAML or JSON in the desired editor. Snake-case top-level keys from the Meshtastic Python config format are supported.
- The desired-config dropdown loads preset files from this repo, and `MeshOregon` is the default preset on startup.
- [desired-config.yaml](/Users/benlipsey/Meshtastic/_github/pdxlocations/meshconfig/desired-config.yaml) remains an editable preset option in the dropdown.
