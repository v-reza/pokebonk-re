# Third-party notices

The MIT license in `LICENSE` covers ONLY the original code in this repository, which is:

- `server.mjs`
- `tools/` (`pull.mjs`, `probe.mjs`, `mirror.mjs`)
- `firebase/` (`backend.mjs`, `shared.mjs`, `backend.test.mjs`, rules + config files)
- `public/turnstile-stub.js`

Everything else is third-party or upstream content, listed below, and is NOT covered by the MIT license.

## 1. Co-op netcode (`net/`)

Ported/adapted from PokéSurvivor (https://github.com/JPTER78/pokesurvivor), which is licensed under the PolyForm Noncommercial License 1.0.0 for all versions after commit b297089 (14-10-2026).

Required Notice: Copyright 2026 JPTER78 (https://github.com/JPTER78/pokesurvivor)

The `net/` modules (`net.mjs`, `codec.mjs`, `coop.mjs`, `codec.test.mjs`, `INTEGRATION.md`) are derivative of that code and remain under PolyForm Noncommercial 1.0.0. They are NOT MIT-licensed. Non-commercial use, study, and modification are permitted; commercial use is not.

## 2. PokéBonk client bundle (`public/assets/`, `public/index.html`, `public/legal`)

The PokéBonk game client (build `mvilprw2`, v0.8.13) is the proprietary, unlicensed work of the PokéBonk project author ("Charcher", https://pokebonk.com). No license is granted for it. It is mirrored here verbatim for local study and interoperability testing only, and must not be redistributed or used commercially. It includes the Vite bundle (`main-*.js`, `news-*.js`, `three-*.js`, CSS, fonts) and the HTML pages.

## 3. Pokémon sprites, portraits, animations

`public/assets/pmd/`, `public/assets/portraits/`, `public/assets/front/`, `public/assets/icons/` — from the PMD SpriteCollab community project (https://github.com/PMDCollab/SpriteCollab), licensed CC BY-NC 4.0 (non-commercial, attribution required). Original Pokémon Mystery Dungeon art by Spike Chunsoft.

## 4. Pokémon data

`public/data/*.json` (pokemon, moves, learnsets, abilities, types, items, sprites) — derived from PokeAPI (https://pokeapi.co). Pokémon names, moves, stats and other data are trademarks and copyrighted material of Nintendo, Creatures Inc., GAME FREAK inc. and The Pokémon Company.

## 5. 3D models, environments, UI art, music (`public/assets/models/`, `public/assets/env/`, `public/assets/ui/`, `public/assets/music/`, `public/assets/items/`)

Created for the PokéBonk project (per its legal page). No license is granted; mirrored verbatim for local study only.

## 6. Fonts

Nunito and M PLUS Rounded 1c, SIL Open Font License 1.1.

## 7. Trademarks

Pokémon and all related names and characters are trademarks of Nintendo, Creatures Inc., GAME FREAK inc. and The Pokémon Company. PokéBonk and PokéSurvivor are unofficial, non-profit fan projects not affiliated with or endorsed by those companies. This repository is a non-commercial fan study project.

If you are the rights holder of any content listed here and want it removed, contact the repository owner.
