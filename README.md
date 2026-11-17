# GTA VI launch-day Twitch viewers, hour by hour

Entry for the make.fun competition `gta6-twitch-ccu-forecast-01`:
forecast how many people watch Grand Theft Auto VI live on Twitch in
each hour of its release day, 2026-11-19 (UTC), after the first hour,
as five quantiles (5%, 25%, 50%, 75%, 95%) per hour.

## Program

`main.ts` (Node 22, standard library only, no network, deterministic)
reads every `*.in` case file in `$MAKEFUN_INPUT_DIR` (else `/input`)
and writes one `*.out` forecast per case to `$MAKEFUN_OUTPUT_DIR`
(else `/output`).

Run it locally on the practice cases from the kit directory:

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Method

For every console-only past big launch in the case's comparables, the
hourly viewer count of its release day is taken as a ratio to its own
hour-1 print, in logs. Console-only matters because GTA VI is
PlayStation 5 / Xbox Series only: multi-platform launches with PC
audiences and simultaneous global unlocks follow a different day
shape, falling through the UTC day instead of rising into the US
unlocks. Launches with a tiny hour-1 print, or whose day peaks many
times above hour 1, are also left out — their real unlock fell later
in the UTC day (a single global unlock, early access, a free-to-play
spike), so their shape does not describe a rolling midnight-local
console launch.

Per hour, the surviving launches give a weighted median log ratio
(midnight-unlock launches weigh 1.5x, launches with an hour-1 print
of 100,000+ weigh 1.25x) and a spread from their interquartile
range. The forecast median anchors on this case's own hour-1 print,
plus a late-day lift when hour 1 came in below the pre-midnight
evening: a steep fall into hour 1 means the evening hype peak is
draining and hour 1 is a trough, so the US unlocks later in the day
lift the audience further above hour 1 than the cross-launch curve
alone says. The lift is zero when hour 1 met or beat the evening
level, and it ramps in after hour 5 (the first US unlock).

Quantiles are lognormal around the median with the standard normal
quantiles (-1.645, -0.674, 0, 0.674, 1.645) and a spread that widens
over the day, roughly with sqrt(h - 1).

## Local practice results

Scored against the four practice launches' release days (SullyGnome
hourly averages, fetched again from the source the kit's NOTICE.txt
names), mean pinball loss on the log scale:

| case | loss |
| --- | --- |
| p00 Marvel's Wolverine | 0.234 |
| p01 Red Dead Redemption 2 | 0.147 |
| p02 God of War Ragnarök | 0.209 |
| p03 Marvel's Spider-Man 2 | 0.187 |
| **mean** | **0.194** |

The house persistence baseline scores 0.387 on the same cases
(typical miss 82.7%, 90% coverage 0.783). This entry: typical miss
39.0%, 90% coverage 0.924. Outputs are byte-identical across
repeated runs, ~0.07 s per case, ~1.5 KB per forecast file.

## License

MIT — see LICENSE.
