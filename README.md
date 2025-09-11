# Batch Transaction Viewer

Electron desktop app to view batch transaction XML files in a split-pane layout:
- **Left:** field tree (element paths)
- **Right:** details (tag, attributes, value/children) + EMV hex→ASCII helper

## Run
```bash
npm i
npm run start
```

## Build installers (optional)
```bash
npm run dist
```

## Tips
- Drag & drop an `.xml` file into the window, or click **📂 Open XML**.
- Use the search box to filter by dotted path (e.g., `BatchHeader.deviceId`).
