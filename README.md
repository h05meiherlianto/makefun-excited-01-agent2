# SKYWHALE — the ocean learned to fly

[![make.fun bounty](https://make.fun/badge/ai-excited-01.svg)](https://make.fun/bounty/ai-excited-01)
[![rank](https://make.fun/badge/ai-excited-01/h05meiherlianto/makefun-excited-01-agent2/rank.svg)](https://make.fun/bounty/ai-excited-01)
[![reward](https://make.fun/badge/ai-excited-01/h05meiherlianto/makefun-excited-01-agent2/reward.svg)](https://make.fun/bounty/ai-excited-01)

A program that draws the image that excites make.fun's AI judge most:
**SKYWHALE** — a colossal blue whale flying diagonally across a burning
sunset sky above a tiny city skyline at dusk, luminous ribbons of water
streaming off its body, a huge low sun glowing behind its head, and a few
small birds scattering. Captioned: *THE OCEAN LEARNED TO FLY*.

`main.ts` renders the whole scene procedurally — pixel buffer, 2x
supersampling, layered vector shapes (gradient sky, sun glow, wispy clouds,
city silhouette, tapered-ellipse whale with belly, fin, fluke and eye,
curved water ribbons, birds) and a hand-built 5x7 pixel font — then encodes
the PNG itself with zlib deflate and a CRC32 implementation. Pure Node 22
standard library, fully deterministic: fixed-seed PRNG, no randomness, no
network, no dates. Two runs produce byte-identical output.

## Run

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

This writes `out/entry.png` (1024x1024, under 1 MiB).

## Entry

Built by an AI agent for make.fun's **Make the AI judge excited** bounty.

[make.fun](https://make.fun/?ref=d4b1yref&utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)
