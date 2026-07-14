# Test Android over Tailscale (Windows + Android)

This is an **attended** flow: the Android owner explicitly enables Wireless debugging and scans a fresh QR code or supplies a fresh six-digit pairing code. It is not unattended access.

## Before starting

- Install Tailscale on the Windows laptop and Android phone.
- Sign both into the same tailnet and keep Tailscale connected.
- On Android, note the Tailscale IPv4 address (`100.x.y.z`) or full MagicDNS name ending in `.ts.net`.
- On Windows, launch ws-scrcpy-web and open `http://localhost:8000`.
- Enable **Developer options → Wireless debugging** on Android.

## Recommended: QR over Tailscale

1. In **Available Network Devices**, select **pair with QR**.
2. Select the **Tailscale** mode.
3. Enter the Android Tailscale IPv4 address or full `.ts.net` hostname.
4. Select **generate Tailscale QR**.
5. On Android, open **Wireless debugging → Pair device with QR code** and scan the code.
6. Keep the Wireless debugging screen open while Windows searches for the temporary endpoints.
7. Wait for **Paired and connected over Tailscale**.

This mode does not require the pairing port, connection port, or six-digit code. A full MagicDNS name is resolved once and must resolve to a Tailscale `100.64.0.0/10` address. The server scans only that validated target's high-port range, uses the random QR password to identify the pairing endpoint, then connects the authenticated secure-ADB endpoint. The session expires after three minutes and all temporary secrets are cleared on completion, failure, cancellation, replacement, or expiry.

## Manual fallback: pairing code over Tailscale

Use this when QR scanning succeeds on the phone but ws-scrcpy-web cannot reach the temporary pairing endpoint, or when the device ROM does not expose Wireless debugging on the Tailscale interface.

1. On Android, open **Wireless debugging → Pair device with pairing code**.
2. Keep that screen open and note its six-digit code and pairing port.
3. Return to the main **Wireless debugging** screen and note the separate connection port.
4. In ws-scrcpy-web, select **pair via Tailscale**.
5. Enter the Android Tailscale address, pairing port, fresh code, connection port, and optional device name.
6. Select **pair & connect**.

The pairing port and connection port are normally different. The browser clears the code immediately after submission and the server redacts it from typed ADB errors.

## Start the stream and test controls

1. Open the connected device.
2. Leave the first test on H.264 with audio disabled.
3. Start the stream.
4. Verify that video updates, a browser click produces an Android tap, and click-drag produces a swipe/scroll.
5. For phone apps, select **Touch** mode if the toolbar starts in D-pad mode.

## Stop access

Disconnect the device in ws-scrcpy-web or turn off **Wireless debugging** on Android. Turning off Wireless debugging removes the ADB network entry point.

## Failure triage

Check in this order:

1. Both devices are online in the same tailnet and Tailscale ACLs allow Windows to reach Android.
2. The Android Tailscale address is current. QR mode accepts only `100.64.0.0/10` or a full `.ts.net` hostname.
3. Wireless debugging remains enabled and the QR/pairing-code screen remains open.
4. Windows Defender Firewall allows ws-scrcpy-web and bundled ADB on the Tailscale network.
5. For manual fallback, the code is fresh and the pairing/connection ports were not swapped.
6. The Android vendor ROM exposes Wireless debugging on its Tailscale interface.

AOSP's pairing and secure-connect servers bind to all interfaces, but OEM networking policy can still restrict reachability. A Tailscale ping succeeding while every Wireless-debugging port remains unreachable indicates a device/OEM constraint rather than a stream decoder failure. In that case, pair on the same Wi-Fi or use a gateway laptop physically located with the phone.

## Acceptance checklist

- [ ] Tailscale QR requires only one Android Tailscale address/hostname.
- [ ] Scanning the QR reaches **Paired and connected over Tailscale**.
- [ ] Manual pairing-code fallback still works.
- [ ] The device appears without USB.
- [ ] Video reaches the browser.
- [ ] Click/tap works.
- [ ] Drag/swipe works.
- [ ] Turning off Wireless debugging disconnects the session.
