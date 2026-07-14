# Test Android over Tailscale (Windows + Android)

> **Same Wi-Fi? Use QR instead.** In **Available Network Devices**, select **pair with QR**, then on Android open **Wireless debugging → Pair device with QR code** and scan it. QR relies on LAN mDNS and avoids entering IP addresses, ports, or a six-digit code. This document covers the remote/Tailscale fallback where LAN mDNS is unavailable.

This flow is **attended**: the Android owner explicitly enables Wireless debugging and provides a fresh pairing code. It is not unattended access.

## Before starting

- Install Tailscale on the Windows laptop and Android phone.
- Sign both into the same tailnet.
- Keep Tailscale connected on both devices.
- On Android, note the Tailscale IPv4 address (`100.x.y.z`).
- On Windows, launch ws-scrcpy-web and open `http://localhost:8000`.

## One-time Android setup

1. Open **Settings → About phone**.
2. Tap **Build number** seven times to enable Developer options.
3. Open **Settings → System → Developer options**.
4. Enable **Wireless debugging**.
5. Open **Pair device with pairing code**.
6. Keep that screen open. It shows:
   - a six-digit pairing code;
   - a pairing port.
7. Return to the main **Wireless debugging** screen and note its separate connection port.

The pairing port and connection port are usually different. Enter each in the matching field.

## Pair and connect from Windows

1. In ws-scrcpy-web, find **Available Network Devices**.
2. Select **pair via Tailscale**.
3. Enter:
   - Android Tailscale IP (`100.x.y.z`);
   - pairing port;
   - fresh six-digit code;
   - connection port;
   - optional device name.
4. Select **pair & connect**.
5. The device should appear in the connected-device list.

## Start the stream and test controls

1. Open the connected device.
2. Leave the default video codec on H.264 for the first test.
3. Start the stream.
4. Verify:
   - the Android screen is visible and updates;
   - a browser click produces a tap on Android;
   - click-drag produces a swipe/scroll on Android.

For phone apps, select **Touch** mode if the toolbar starts in D-pad mode.

## Stop access

Use either method:

- disconnect the device from ws-scrcpy-web; or
- turn off **Wireless debugging** on Android.

Turning off Wireless debugging immediately removes the ADB network entry point.

## If pairing fails

Check in this order:

1. Both devices are online in the same Tailscale tailnet.
2. The Android Tailscale IP is current.
3. The pairing code has not expired; generate a new one.
4. Pairing port and connection port were not swapped.
5. Windows Defender Firewall allows ws-scrcpy-web and ADB on private/Tailscale networks.
6. The Android vendor ROM allows Wireless debugging while Tailscale is active.

Some Android builds bind Wireless debugging only to the current Wi-Fi interface. If the direct Tailscale path fails on that phone, first pair while both devices are on the same Wi-Fi, then retry the Tailscale connection port. A device-specific failure here is a platform/OEM networking constraint, not a streaming failure.

## Acceptance checklist

- [ ] `pair via Tailscale` returns “Paired and connected”.
- [ ] The device appears without USB.
- [ ] Video reaches the browser.
- [ ] Click/tap works.
- [ ] Drag/swipe works.
- [ ] Turning off Wireless debugging disconnects the session.
