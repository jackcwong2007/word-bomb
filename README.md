# Brainrot Wordbomb

Five-player browser Word Bomb with a separate laptop display. Requires Node.js 18+.

```sh
npm ci
npm start
```

Open `http://localhost:3000/?display=1` on the laptop. The terminal prints its network addresses and room code. Five phones on the same network open the printed network address and enter that code plus their names. The first player controls Start. The display does not use a player seat.

For a fixed room code, run `ROOM_CODE=BRAIN67 npm start` on macOS/Linux. In PowerShell, run `$env:ROOM_CODE="BRAIN67"; npm start`.

- Real words containing the displayed letters: +10 aura.
- Brainrot words from `data/stupid.txt`: +67 aura.
- Timeout: lose one life and 100 aura. Two lives per player.
- Last survivor wins. Aura is a separate leaderboard and resets each round.
- Turns shorten and prompts get harder as more answers are accepted.
- Disconnected seats are reserved for 20 seconds. Reopening on the same browser restores the seat.

The room code identifies one game on this server. It is not a public hosting service or an access-security boundary. Venue Wi-Fi may isolate devices; use a network that allows phones to reach the laptop and permit Node through the laptop firewall.

## Test

```sh
node test/multiplayer.js
```

Exercises the server with a spectator, five players, a rejected sixth player, room-code validation, reconnection, word scoring, and timeouts.

Hardware activation, camera capture, message sending, and QR generation are not included in this version. The core game uses only the existing `ws` dependency.
