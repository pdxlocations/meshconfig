# MeshConfig Workbench

Static web app for direct Meshtastic config work:

- connect over USB serial, Web Bluetooth, or HTTP(S)
- download the node's writable config as YAML
- compare live config to a desired YAML document
- upload the desired config back to the node

## Run locally

Serve this directory from a static web server:

```sh
python3 -m http.server 8420
```

Then open:

```text
http://localhost:8420
```

Or use the launcher script:

```sh
./scripts/launch.sh
```

## systemd

A sample systemd unit is included at systemd/meshconfig.service.

It assumes the app is installed at `/opt/meshconfig` and uses a dynamic service user, so you only need to adjust the install path if yours is different.

## Notes

- Web Serial and Web Bluetooth require a Chromium-based browser and a secure context.
- The exported YAML is intentionally focused on writable settings. It excludes transient admin session data.
- The app accepts YAML or JSON in the desired editor. Snake-case top-level keys from the Meshtastic Python config format are supported.
- The desired-config dropdown loads preset files from this repo, and `MeshOregon` is the default preset on startup.
- [desired-config.yaml](/Users/benlipsey/Meshtastic/_github/pdxlocations/meshconfig/desired-config.yaml) remains an editable preset option in the dropdown.
