# Wuxing Heroes — Online PvP Prototype v0.51

This build combines the full v0.50 browser game with a persistent Node.js online server.

## What v0.51 adds

- Online player-vs-player rooms with 6-character invite codes.
- All five public decks are available online: Earth, Fire, Wood, Metal and Water.
- The Unknown Sovereign deck becomes selectable online only after that profile has unlocked it in Story Mode.
- Persistent online player profiles.
- Automatic cloud merge of Story clears, Secret Story clears, Gold/alt-art unlock conditions, Mystery Figure O wins and playmat unlock flags.
- Existing v0.50 local progression is imported when an online profile is first created.
- Returning players automatically restore their online profile on the same browser.
- A Profile ID + Recovery Code can restore the profile on a different browser/device.
- Active online matches remain saved when a player closes the browser or uses Save & Exit.
- Returning to Online PvP resumes the saved room automatically.
- The server saves the latest stable game state to disk and can restore active rooms after a server restart.
- Online mulligans, card-effect choices, Ambushes, Guardians, active Hero/Creature abilities, attacks and turn progression are server-authoritative.
- Opponent hands and face-down Hero cards remain hidden from the other client.
- English/Simplified Chinese card names, logs and core online interface text are supported.
- The existing battle music/SFX system is available online.

## Run locally

Requires Node.js 18 or later.

Windows: run `START_WINDOWS.bat`.

macOS/Linux:

```sh
./start_mac_linux.sh
```

Then open `http://localhost:8080`.

## Persistent save location

By default the server stores profiles and active rooms in:

`server-data/wuxing-online-state.json`

Set `WUXING_DATA_DIR` to another directory to keep data on a mounted persistent disk in production.

## Important deployment note

Do not deploy this version to an ephemeral filesystem if you want cloud profiles and unfinished matches to survive server restarts/deployments. Mount persistent storage and set `WUXING_DATA_DIR` to that mount path.

The prototype intentionally uses one authoritative Node server instance. Do not run multiple replicas against the same JSON save file.
