# UniversalTrans

> AirDrop-style bidirectional file transfer between PC (Windows, Linux) and mobile devices (Android, iOS, iPadOS) over local WLAN.

## Features

- **Point-to-Point LAN Transfer**: Direct Wi-Fi speed (WiFi 5/6), no cloud or external internet connection needed.
- **Cross-Platform**: Windows, Linux, Android (Chrome PWA), iOS / iPadOS (Safari PWA).
- **CLI & Web Interface**: Launch with files to share (`utrans file.mp4`) or drop files into the browser.
- **Large File Ready**: Chunked upload support for files up to 10GB with auto-resume.
- **Dark Mode UI**: Sleek, glassmorphic dark interface optimized for desktop and mobile.

## Quick Start

### 1. Installation

```bash
npm install
```

To install globally as the `utrans` command:

```bash
npm install -g .
```

### 2. Usage

Launch server:

```bash
utrans
```

Share specific files or folders immediately:

```bash
utrans photo.jpg /path/to/my-folder/
```

Access from mobile:

- Connect phone to the same Wi-Fi.
- Scan the QR code displayed on the PC terminal or browser.
- Or open `http://<your-lan-ip>:3456`.

## Development

```bash
# Run unit tests
npm test

# Run tests with coverage
npm run test:coverage

# Lint code
npm run lint

# Start with nodemon
npm run dev
```

## License

MIT
