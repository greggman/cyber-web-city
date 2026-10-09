# Cyber Web City Art Bible

This is the art direction contract for the procedural city. The engineer implements it. The visual judge reviews screenshots against section 14. All numbers are defaults: change them only together with this file.

Two words used throughout:

- **Bay**: one structural column spacing along a face, in meters.
- **Floor**: one floor-to-floor height, in meters.

Every kit piece is placed by (bay index, floor index, bay class), never by a free random offset.

---

## 0. Diagnosis of the current build

| Symptom | Where it shows | Cause in code |
|---|---|---|
| **Willy-nilly boxes.** Bolted-on room boxes of random width (4 to 10 m), depth (2 to 5.5 m), height (1 to 3 floors) and ±1.5 m jitter, at 30% density on slum faces. They line up with nothing. | `facade.png` (the lower block), `chase-060` (left slab, the speckled boxes), `roofs.png` (tower flank) | `details_emit.wgsl` "Bolted-on room modules": an 11 m slot grid unrelated to the window grid, a free X jitter, and a per-slot hash. |
| **Massing bays ignore the grid.** Jutting volumes have a random width (6 to 20 m), a random height (30 to 95% of the tier), a random vertical offset, and a 40% chance of a *different facade style* from their host. | `chase-030` (left tower's mismatched slabs), `skyline-020` | `kitbashTier()` in `buildings.ts`: `alt()` style swap, `r.range` for every dimension |
| **Service shafts at random X.** | `chase-005` (the dark verticals on the left) | `details_emit.wgsl` "External service shafts": `X = (u2f(sh)-0.5)*(wBase-6)` |
| **The kit and the shader windows disagree.** Box facade u runs from the face centre (`meshes.ts`), so shader cells have an edge at u=0. The kit centres `nCols` cells, which is off by half a cell when `nCols` is odd. Slum cell width is re-rolled every floor, so nothing can stack. The corridor shrink (`generate.ts`, factor k) rescales faces after the bay count was chosen, so partial windows appear at corners. | `facade.png` (AC units not under windows), `street.png` (upper windows clipped at corners) | three independent grid definitions |
| **Neon edge strips everywhere.** Full-height red and magenta edge lines are the dominant read of whole buildings. Every tier is outlined. Floor bands outline whole towers. There is no hierarchy. | `chase-005`, `pov-010`, `pov-045`, `chase-150`, `skyline-020`, `skyline-200`, `roofs.png` (the yellow verticals) | `EdgeGlow` / `FloorBands` / `TopGlow` handed out by chance (25% to 40%), plus the `NEON_SHARE` fallback of 15% |
| **"2002 game" towers.** Large flat curtain walls carry only a 1.6 m window texture. There is no mid-scale relief between 3 m and 30 m (mechanical floors, piers, setbacks, crown structure). | `chase-030` (the right tower is a texture on a box), `pov-010` | Glass towers get mullions and ledges only. Their setbacks are random 72 to 90% shrinks with no relationship to the bay. |
| **Pepper-shaker roofs.** Equal-sized HVAC units, tanks and stacks are spread evenly over a jittered 8 m grid, and lit "skylight" squares are scattered. Nothing clusters around a penthouse or a core. | `roofs.png`, `roofs2.png` | rooftop loop in `cs_emit` (62% fill per 8 m cell) |
| **Thin streets.** Every 8 m there is an identical sign box at the same height and brightness. There is no awning depth, no stalls, no vertical blade signs at street level, no cables at shop height, and empty pavements. Upper floors are blank, giant panes. | `street.png`, `street2.png` | One canopy type every 8 m (75%). The podium has a 6 m floor with huge windows. |
| **No skyline rhythm.** Many towers share the same height band, landmarks are not spaced, and haze is uniform. | `skyline-200`, `skyline-020` | `H = range(220,650)*hs` independent per lot |

What already works: the interior-mapped rooms, the wet streets, the market blade signs in `chase-060`, and the Megablock balcony recesses in `facade.png`, which are the closest thing to the target. Keep all of them.

---

## 1. References (what we take from each)

What we take in practice (the sourced facts are in section 1a):

- **Unity Megacity:** buildings are assembled from nested prefabs (greeble, then module, then building, then block) snapped to a grid, then dressed with many small "greeble" props (AC units, pipes, signs, cables) that follow the modules. The density comes from repeating the same props *per module*, not from scattering them.
- **Hong Kong public housing (Choi Hung, Harmony and Trident blocks, Yick Cheong):** identical flats stacked into identical columns. The richness comes from tenant variation inside a rigid grid: one window caged, one AC on the left, laundry poles, one unit repainted. Re-entrant light wells are full of pipes and AC units.
- **Kowloon Walled City:** about 14 storeys, capped by an airport height limit. Buildings are fused into one mass, there are rooftop shacks everywhere, and every window has a cage. It is chaotic in content but every addition sits on a window.
- **Chongqing and Shenzhen:** 30+ storey slab towers with 3 m floors on top of 4 to 6 storey podiums. "Handshake" urban villages of 7 to 9 floors stand 1 to 2 m apart. Raffles City has a horizontal skybridge across tower tops.
- **Blade Runner 2049:** monolithic, brutalist masses with almost no windows, read through haze. Light comes from enormous ads and from small warm windows. The Las Vegas sequence uses an orange monochrome.
- **Blade Runner (1982):** "retrofitting": ducts and services are bolted onto old buildings and follow their structure.
- **Ghost in the Shell (1995):** Hong Kong canyons with layered signage, overpasses, water and a muted green-grey palette.
- **Cyberpunk 2077:** each district gets its own architectural era and sign language. Corporate is clean and vertical with few lights. Kabuki and Japantown have a maximal sign density at street level. Pacifica and Heywood are unfinished concrete with sparse light.

### 1a. Research notes

- **Unity Megacity** (Unite LA 2018, released at GDC 2019) had 4.5M mesh renderers, 200k unique building objects, 5,000 vehicles and 100k audio sources (neon signs and AC fans each had a sound). It was built by two artists from the FPS Sample team in about two months.
  - It used **nested prefabs**: a greeble goes into a facade module, the module into a building, the building into a block.
  - Takeaway: the density comes from a small kit repeated through a hierarchy, not from scattering. No module dimensions are published.
- **Kowloon Walled City** held about 33k people on 2.6 ha in roughly 350 buildings.
  - Buildings were 10 to 14 storeys, capped by the Kai Tak flight path, so the roof is a flat plateau.
  - Flats were about 23 m². Alleys were 1 to 2 m wide and lit by fluorescent tubes. There were only 8 municipal water pipes, so plumbing bundles ran everywhere.
  - Roofs carried antennas, laundry, tanks and ladders. Clinics and workshops meant a lot of small signs.
- **Monster Building (Quarry Bay):** 5 joined 18-storey blocks with 2,243 units. Its courtyard walls are a grid of balconies, AC units, laundry and cages.
- **Choi Hung Estate (1962 to 1964):** 11 slabs and about 7,400 units, painted **one pastel hue per block** in a rainbow sequence.
- **HK Housing Authority block types:**
  - Twin Tower (24 to 28 storeys), Cruciform (about 30), Trident (about 35, three wings around a lift lobby), Harmony (38 to 41, cruciform).
  - Residential floor-to-floor height is **2.75 m**.
  - Up to 500k caged window extensions exist city-wide. Bamboo laundry poles project from windows.
- **Chongqing and Shenzhen:**
  - Liziba: a monorail runs through a 19-storey block at floors 6 to 8.
  - Raffles City: a horizontal "Crystal" 300 m long, 32.5 m wide and 26.5 m tall, sitting on four towers of about 250 m.
  - Shenzhen urban villages: "handshake" buildings of 6 to 10 storeys (20 to 30 m), with gaps as small as about 2.5 m.
  - Typical mainland towers are 33 storeys at about 3 m (just under the 100 m refuge-floor rule), on podiums.
- **Blade Runner (1982):**
  - Syd Mead's "retrofitting": pipes, ducts and machinery bolted onto existing facades.
- **Blade Runner 2049:**
  - Gassner's "brutality". The architecture is top-heavy: buildings gain mass as they rise.
  - The city was built in 3 detail tiers (megastructures, mid-ground, distant).
  - Constant rain and smog. Las Vegas is an orange monochrome against desaturated grey-teal LA.
- **Ghost in the Shell (1995):** based on black-and-white photos of Kowloon Walled City taken before its demolition. The palette came from separate colour photos. Ogura's lens misting as he stepped from an air-conditioned shop into humid night air inspired the bloomed, hazy billboards.
- **Cyberpunk 2077:**
  - Night City was hand-built. Texture density is 2× The Witcher 3's, guided by a "rule of contrast".
  - Four eras:
    - **Entropism**: patched concrete, for poor districts.
    - **Kitsch**: neon and plastic.
    - **Neomilitarism**: dark glass and metal, for corporate districts.
    - **Neokitsch**: luxury.
  - Each district mixes the eras in its own proportions. That maps onto ours as Slum = Entropism, Market = Kitsch, Core and Corporate = Neomilitarism.

---

## 2. Pillars

1. **Detail follows structure.** Every kit piece is snapped to a bay and floor of a single shared grid. No piece has free XY jitter. Where the eye sees a pattern break, it must be a *tenant* break (a whole unit or a whole column changes), never a random offset.
2. **Repetition with tenant variation.** Decide at the highest level first: building, then face, then column, then unit, then cell. Item *type* is chosen per column (a vertical stack). Item *presence* is chosen per unit with a high base probability. The cell level only varies content such as light colour, curtains and wear.
3. **Base, shaft, crown.** Every building has three readable zones with different programs. The base is busy, warm and human-scale. The shaft is a repetitive grid. The crown is structure, services and a single signature light.
4. **Density where the camera looks.** The flight corridor faces between 60 and 350 m altitude get the full kit and hero dressing. Everything else gets a cheaper program that keeps the same silhouette rules.
5. **Light is a budget, not a default.** Neon is rare and placed with purpose: signs, crowns and mechanical floors. Most light comes from warm windows and street-level shops. Edge strips are reserved for a few landmarks.

---

## 3. The shared grid (prerequisite for everything)

- Each segment carries `bayW` and `floorH`. Encode `bayW` in the **alpha byte of `colorA`** as decimetres (`bayW = a * 0.1 m`, range 0.1 to 25.5 m). Encode the **typology id** in the **alpha byte of `colorB`** (0 to 255). Both alphas are unused today: `unpack_color` reads `.rgb`. Add `fn seg_bay(s)` and `fn seg_typology(s)` to `segment.wgsl`.
- **Face snapping.** In TS, when a typology creates a box segment, choose `nBays = floor((W - 2*cornerMin)/bayW)` and set `W = nBays*bayW + 2*corner`, with `corner ∈ [0.6, 1.5] m`. The corner zone is a solid pier with no windows or kit.
- **Corridor shrink.** When the warp shrink in `generate.ts` must shrink a face, drop whole bays from `nBays` (both sides symmetric if possible) instead of scaling by k.
- **Grid origin.** Bays are symmetric about the face centre, matching the `meshes.ts` facade u. Bay i spans `u ∈ [(i - nBays/2)*bayW, (i+1 - nBays/2)*bayW]`. `facade.wgsl` (via `WinStyle.cellW`) and `details_emit.wgsl` (`grid_for`) **must call one shared function** `bay_of(s, u) -> (index, frac)` that lives in `segment.wgsl`. Delete the private grids in each file.
- **Floors.** Row j spans `[j*floorH, (j+1)*floorH]` from world y=0, as today. The podium height is always an integer number of podium floors. The tower starts on a floor line.
- **Bay classes.** Each typology defines a repeating **rhythm string** over bay indices, for example `"WWSWWC"`, mirrored about the face centre. The classes are:

| Class | Meaning | Shader | Kit |
|---|---|---|---|
| W | window bay (a flat's living room) | window and interior | AC, cage, balcony, laundry, sill |
| N | narrow window bay (kitchen or bath) | small high window, 0.6×0.8 m | exhaust vent, pipe |
| S | service bay | blank wall | riser pipes (2 to 4), downpipe, AC stack |
| C | core bay (stairs and lifts) | glass-block slot or louvres | none; it continues as the penthouse above the roof |
| P | pier | solid | fin or pilaster, full height |
| G | glass module (office) | curtain wall | mullion; every 6th is a heavy pier |

---

## 4. Typologies

Each district picks a typology by weight. "p=" is a probability. Unless a sentence says otherwise, every variation listed is drawn **once per building** from the building seed.

### 4.1 Core (downtown)

**C1 Curtain-wall supertall** (weight 3; replaces the glass branch of `setbackTower`)

- **Massing.** Footprint 40 to 70 m square, or 1:1.6 at most. Total height 250 to 650 m, or 900 to 1700 m for a landmark.
- **Podium.** 4 floors × 6 m = 24 m, flush with the lot minus 2.5 m.
- **Tower.** Inset 1 bay (9 m) from the podium.
- **Setbacks.** Only at mechanical floors, 1 module group (9 m) per side, 2 or 3 setbacks in total.
- **Grid.** 1.5 m glass modules (G) grouped into 9 m structural bays (one P every 6 G). Floor height 4.2 m.
- **Mechanical floor.** Every 15 floors: double height (8.4 m), louvre band, 0.9 m deep slab ledge, maintenance catwalk on the hero faces.
- **Base.** Double-height lobby glass (12 m) and 9 m shopfront bays.
- **Shaft.** G modules, mullion fins on every module (0.15 m deep), and a 0.8 m pier every 9 m.
- **Crown.** Top 3 floors are an open lattice (Structure style, the same footprint), with a mast or spire (p=0.5) and a single crown light.
- **Kit.** `fin` on the mullions. `ledge` at every floor (0.2 m) and at mechanical floors (0.9 m). `louvre` (new) on mechanical floors. `catwalk` (new) on hero faces.
- **Variation.** Glass tint is cool or neutral per building. Lit floors come in office blocks: whole floors are lit or dark in runs of 2 to 6 (p lit=0.55 per run). Within a lit floor, each 9 m bay is dark with p=0.15. Blinds are chosen per floor.
- **Pattern breaks.** At most 1 "sky lobby" void per tower (current p=0.22 is fine), placed only at a mechanical floor.
- **Palette.** Glass is dark blue-grey (albedo 0.03), mullions are 0.5 grey metal, piers are dark granite. Window light is 70% cool-neutral (5000 K) and 30% warm. One neon accent at the crown only.

**C2 Stone monolith office** (weight 1.5; Monolith style)

- **Massing.** One extrusion with slight taper (0.9 to 1.0). Height 200 to 500 m.
- **Grid.** Bay 6 m, floor 4.2 m. Strip windows 1 floor out of 3 (as in the shader). P fins full height every bay, 0.9 m deep.
- **Base.** A 3-floor recess (an arcade 4 m deep) shown as columns. Model it as a segment inset 4 m under the main mass, which has a 12.6 m soffit.
- **Crown.** A blank 15 to 30 m parapet band, with red beacons at the corners.
- **Variation.** Strip-window light runs are long: whole bands are lit (p=0.5).
- **Palette.** Albedo 0.06 basalt, satin. Warm 3200 K light only. No neon on the body.

**C3 Round or twist landmark** (weight 1 normally, 2 for landmarks; cylinder or twist towers)

- **Grid.** The facet bay is 3 m, which the facet count must honour: `facets = round(circumference/3)`. Floor 4.2 m.
- **Light.** Rings are allowed **only at mechanical floors** (every 15 floors), and at most 4 per tower.
- **Crown.** Spire plus beacon.
- These are the only Core buildings allowed `EdgeGlow`, and then only on the top 30% of the height.

**C4 Bridged cluster or gate** (weight 1; keep `bridgedCluster` and `gateTower`)

- The bridge floor height is 4.2 m and its underside is lit.
- **Tower faces.** Use C1 rules.
- **Bridge.** It has its own grid: 3 m modules and a continuous ledge. It carries one horizontal sign, at most 60 m wide, centred over the avenue.

### 4.2 Megablock (Mega-City slabs, Hong Kong public housing)

**M1 Slab block** (weight 3; replaces the body of `megablock`)

- **Massing.**
  - Footprint 30 to 45 m deep, 80 to 200 m long.
  - Podium 5 floors × 4.5 m = 22.5 m (a market or car park with louvres).
  - Slab height 300 to 650 m, split into "stacks" of 30 floors separated by a 2-floor **sky street**: inset 3 m, lit, Bridge style, ledges with railings.
  - Upper stacks may step in 1 unit (7.2 m) on the long faces only (p=0.4 per sky street).
- **Grid.** Floor 2.75 m (HK Housing Authority standard). Bay 3.6 m. A flat is 2 bays. The rhythm per long face is `"WN WN WN S WN WN WN C"` (mirrored), i.e. 3 flats, a service bay, 3 flats, a core. The short faces are `"P W W P"` with `C` in the middle.
- **Base.** Car-park louvres across full bays. The shop row at ground level follows section 7.
- **Shaft.**
  - **Balcony columns.** p=0.45 per W column. They are stacked from the 2nd floor of the stack to its top, and the whole column has the same railing type (solid concrete or glass, p=0.33 glass).
  - **AC.** One unit per W bay, always under the window, always on the same side within a column (the side is chosen per column). Present per unit with p=0.8.
  - **Cages.** Per unit p=0.12 in a non-balcony W column.
  - **Laundry poles.** Per unit p=0.25, in W columns without balconies, 3 poles 1.6 m out.
  - **N bays.** A small vent hood at every floor.
  - **S bays.** 3 riser pipes, continuous full height, with collars every floor. Downpipes come from the roof.
  - **C bays.** Glass-block slot, lit cool, stair-landing windows offset by half a floor.
- **Crown.**
  - The core bays continue 2 floors above the roof as lift-motor rooms.
  - A water-tank cluster sits on the cores.
  - There is a parapet, and a rooftop sign frame on the avenue face (p=0.35).
- **Variation (tenants).**
  - Per unit: curtain colour from 6, lit p=0.45, light colour 75% warm or 25% cool-TV flicker.
  - Enclosed balcony (glazed in by the tenant) with p=0.15 per balcony unit.
  - A "renovated band" of 3 to 6 floors repainted in an alternate wall tone (p=0.25 per stack).
  - No other breaks.
- **Palette.**
  - Concrete is mid grey 0.32 or painted pastel. Choi Hung style: one muted hue per stack, chosen from {faded salmon, mint, butter, sky}, at 0.35 to 0.45 albedo and desaturated 50%.
  - Railings are 0.2 grey. AC units are 0.6 off-white with a rust drip.
- **Light.** 70% warm (2700 to 3000 K), 15% cool, 15% tinted (TV and curtains).
- **Neon.** Sky-street underside strip only, plus the rooftop sign.

**M2 Cruciform or Trident tower** (weight 2; new)

- **Massing.** Two or three box segments crossing at the centre, each wing 14 to 18 m wide and 30 to 45 m long. Height 120 to 260 m. Podium 3 floors.
- **Re-entrant corners** (light wells) are where the density goes. Every S bay facing a well carries 4 risers. AC density in wells is per unit p=0.95.
- **Grid.** As M1. Wing-end faces are `"W W W"`, with balconies on all 3 (p=0.6 per building).
- **Crown.** A core penthouse at the crossing, plus a tank cluster.

**M3 Podium deck with towers** (weight 1; new)

- One 6-floor podium (5 m floors) fills the block. 2 to 4 M2 towers stand on top. The podium roof is a deck with planters, a pool (a dark plane) and lit paths.
- Podium faces use car-park louvres plus a market ground floor.

### 4.3 Slum (Kowloon Walled City, vertical Chongqing)

**S1 Walled-city tenement mass** (weight 3; replaces `slumStack` for heights below 70 m)

- **Massing.**
  - Lots are 6 to 14 m frontage (as today). Gaps between buildings are 0 to 1.5 m (fused).
  - Heights 30 to 45 m (10 to 15 floors at 2.8 m). Neighbouring heights differ by 0 to 3 floors.
  - Each building is **one tenement with its own bay width**: 2.4, 2.8 or 3.2 m, chosen per building, **never per floor**.
- **Cantilevered rooms.** Upper floors (from the 4th floor up) may cantilever 0.6 to 1.2 m over the street on the street face, as whole-face slabs that span the full width and 1 to 4 floors (p=0.4). Each cantilever is a separate segment that shares the bay.
- **Rhythm.** `"W W W S"` repeating. Wall tone is per building (4 tones).
- **Kit.**
  - **Cages.** Per W column p=0.55, and a caged column is caged from the 2nd floor to the top with per-unit dropouts at p=0.15.
  - **AC.** Per unit p=0.6, on the same side within a column.
  - **Awnings.** Small 0.6 m awnings over windows, only on non-caged columns, per unit p=0.3.
  - **S bays.** Bundles of 2 to 5 pipes plus cable runs.
  - **Small neon.** One per building at most, at floors 2 to 5, on the street face.
- **Crown.** Rooftop shacks on 60% of roofs, clustered against one parapet. There are antenna forests (5 to 15 masts of 2 to 6 m per roof) and tanks.
- **Variation.** One "rebuilt" tenement per 6 has a different bay width and material (metal sheet). Mismatched floor heights between neighbours are allowed (the slab lines don't meet). That mismatch *is* the slum signature, but it must happen *between* buildings, not within one.
- **Palette.** Stained concrete 0.22 to 0.3, tile in faded green or white on 20% of buildings, rust. Light is 60% warm, 20% fluorescent cool-green (4500 K, greenish), 20% tinted (pink or teal curtains).

**S2 Vertical slum tower** (weight 2; current `slumStack` above 70 m)

- Stacked tiers of 15 to 60 m, as today, but **each tier is an S1 tenement**: one bay width, one tone and one rhythm per tier.
- **Tier joints.** Each tier boundary gets a 1-floor transfer slab (Structure style, 1.2 m ledge) with pipes running across it horizontally.
- **Tier offsets.** Snap to a multiple of the tier's bay width.
- **Kit.** Bay stacks from `kitbashTier` become **enclosure stacks** (section 5, part 14): 1 or 2 bays wide, full tier height, flush to the bay lines.

**S3 Handshake village** (weight 1; new, on the slum edges)

- 7 to 9 floors at 3 m, 10 to 14 m square footprints, gaps 1.5 to 3 m.
- Cable webs span the gaps every 2 floors. Each building has its own tile colour.
- One shop per building at the ground floor.

### 4.4 Market (neon canyons)

**K1 Sign tower shophouse** (weight 3; replaces the market `setbackTower` and `wedgeTower`)

- **Massing.** Frontage 8 to 16 m. Height 60 to 200 m. Podium 3 floors × 4.5 m. Setbacks only at the 1/3 and 2/3 heights, 1 bay each.
- **Grid.** Bay 3.2 m, floor 3.2 m (residential) or 4 m (commercial above the podium).
- **Signs.**
  - **Blade signs.** One vertical blade per building on the avenue face, at the corner bay, from the podium top to 20 to 60 m. Width 1.5 to 3 m, protruding 2 to 4 m.
  - **Projecting horizontal signs** stacked at floors 2 to 4, one per bay pair, alternating heights. These are the Mong Kok canopy.
- **Shaft.** W/S bays with AC stacks (per unit p=0.7). Glazed balconies p=0.3 per column.
- **Variation.** Each floor of the podium is a different tenant (its own light colour and sign).

**K2 LED mall slab** (weight 1; `ledSlab`)

- The LED skin goes **only on the 1 or 2 faces that see an avenue**. The other faces are K1 residential or metal.
- The LED zone is framed by a 1.5 m metal border and 1 m piers every 12 m.

**K3 Mixed tenement over a market hall** (weight 1.5)

- The podium is a 2-floor market hall (8 m clear) with a stall layer (section 7).
- Above it, an M1 grid is used, but at a 3.0 m bay and 22 floors at most.

### 4.5 Corporate

**P1 Arcology pyramid** (keep `pyramid`)

- Each terrace is 2 floors of 5 m with a 1.5 m louvred parapet.
- Strip windows run along every terrace; 40% of runs are lit, warm amber.
- A single summit light. No other neon. Spotlights rake up the faces (where the light system allows).

**P2 Monolith HQ**

- C2 rules at 2× the scale: 12 m bays and 3 m deep fins.
- No windows on 2 of the faces. A single logo sign 40 to 80 m tall on the avenue face.

---

## 5. Kit of parts catalog

The axes are W along the wall, H up and D out from the wall. "Std" marks a piece used by default.

| # | Part | Status | Dimensions (m) | Sub-parts | Material | Alignment | Used by |
|---|---|---|---|---|---|---|---|
| 0 | `ledge` (slab edge) | keep | W=face, H 0.2 to 0.5, D 0.25 to 0.9 | 0.12 m drip lip | concrete or dark metal | every floor line (residential), every floor (glass), deep at mech floors | all |
| 1 | `fin` (mullion or pier) | keep for mullions and piers; **retire its "service shaft" use** | W 0.15 to 0.9, D 0.15 to 3 | lit slot (crown only) | dark metal or stone | G and P bays only, continuous over a zone | C1, C2, P2 |
| 2 | `pipe` (riser) | redesign | Ø 0.15 to 0.35, continuous | collar each floor, bracket each 2 floors, elbow at top | dark metal, rust | S bays: 2 to 5 at a 0.45 m pitch; downpipe at P corners | M, S, K |
| 3 | `ac` | redesign | 0.9 × 0.62 × 0.6 | bracket, grille, fan, **drip tray and condensate pipe 0.03 m down to the next unit** | off-white plastic 0.6, rust bracket | under the W window sill; left or right side fixed per column | M, S, K |
| 4 | `balcony` | keep, tune | W = full bay − 0.2, H 1.1 rail, D 1.2 to 1.5 | slab, rail (solid/glass/bars, per column), soffit lamp | concrete | W columns, every floor of the column | M1, M2, K1 |
| 5 | `awning` | keep | W = window + 0.4, D 0.6 to 0.9 | valance | striped fabric | over the W window, non-caged columns | S1, K |
| 6 | `cage` | keep | window + 0.15 m frame, D 0.45 | bars at a 0.12 m pitch, sill junk | dark metal | W columns, stacked | S1, S2, M1 (rare) |
| 7 | `vent` | keep | 1.2 × 0.7 × 0.36 | louvres | dark metal | N bays every floor; metal facades every 3rd floor on the same column | M, C1 mech |
| 8 | `canopy` (shop) | redesign | W = shop bay, D 1.5 to 3.5 | fascia sign band 0.8 m, lit soffit, **depth and height vary per shop** | metal | each shop bay | all podiums |
| 9 | `module` (room box) | **retire as placed now**; replace with #14 | | | | | |
| 10 | `hvac` | keep | 3 to 6.5 footprint | fans | grey metal | roof clusters (section 9) | all roofs |
| 11 | `tank` | keep | Ø 2.4 to 4.6 | legs, bands | rust or grey | clusters of 2 to 6 on cores | M, S, K |
| 12 | `dish` | keep | Ø 1.5 to 3.5 | | white | parapet edges, 0 to 4 per roof | S, K |
| 13 | `ventstack` | keep | Ø 0.4 to 1, H 1 to 3 | cap | metal | in rows of 3 to 6 along penthouse walls | all |
| 14 | `enclosure` (new; replaces `module`) | new | W = 1 or 2 bays exactly, H = 1 to 4 floors exactly, D 0.8 to 1.6 | frame, window per bay aligned with the host's windows, sill, roof drip lip | metal sheet or painted panel | snapped to bay lines; always the full column height of its zone, or a 1 to 4 floor stack starting on a floor line | S1, S2, K1 (tenant enclosures) |
| 15 | `louvre` band (new) | new | W = bay, H = mech floor, D 0.1 | blades at a 0.2 m pitch | dark metal | mechanical floors, car-park podiums | C1, M1 podium |
| 16 | `laundry` (new) | new | 3 poles × 1.6 m, cloth quads | clothes (fabric part, accent colour) | fabric | under the W window, p per unit | M1, M2, S1 |
| 17 | `catwalk` (new) | new | W = face, D 1.0, rail 1.1 | grating, rails, brackets every bay | dark metal | mech floors on hero faces | C1, M1 sky street |
| 18 | `sign_blade` (exists in `signs.ts`) | rules only | see section 7 | | | corner bays | K, S, M bases |
| 19 | `window frame` (shader) | new in shader | 0.08 frame, 0.12 sill lip | | aluminium or concrete | every window | all |

**Retire or redesign summary:**

- Retire the random-slot `module`.
- Retire the random-X service shaft (`fin` misuse).
- Redesign `pipe` (S-bay bundles), `ac` (drip and condensate) and `canopy` (varied depth and height).
- Stop the `kitbashTier` style swap and its random bay dimensions. Bay stacks become `enclosure` stacks at **segment** scale: W is an integer number of bays, the height is the full tier or a multiple of 5 floors, the style is the host's, and the depth is 1.5 to 4 m.
- Ring bands only at mechanical floors.
- Pilasters only on the C2 and P2 corners.

**Instance budget.** The caps are fine. Shift the caps from `module` (30k) to `enclosure` (20k), `laundry` (60k) and `louvre` (30k).

---

## 6. Placement algorithm (`details_emit.wgsl`)

For each face, walk **columns** (bay index i), then **rows**:

1. `cls = rhythm[typology][mirror(i)]`. The column hash is `hc = hash(seg.seed, face, i)` and decides the column's item type, AC side and railing type.
2. Unit hash `hu = hash(hc, floor / unitFloors)`. Presence is `u2f(hu) < p_presence[typology][item]`.
3. The cell hash only sets content (lit, colour, open or closed). **It never sets position.**
4. Positions are exact functions of the bay: AC at `bayCentre ± (winW/2 - 0.5)` and `y = floor + sill - 0.05`. A cage exactly frames the window. Pipes sit at the S-bay centre ± k·0.45.
5. Zones: `zone = base` if `y < podiumTop`, `crown` if `y > top - crownH`, otherwise `shaft`. Each zone has its own program, and the base program never runs above the podium.
6. Corners (the pier zone) get nothing except downpipes.

---

## 7. Composition: street and block

**Street layer (0 to 12 m), every podium face:**

- **Shop bays** follow the podium bay: 6 to 9 m in Core, 4 to 6 m in Market and Slum. Each shop rolls once:
  - canopy depth 1.5 / 2.5 / 3.5 m
  - fascia height 0.6 to 1.2 m
  - mount height 3.2 to 4.0 m
  - shutter closed p=0.15 (dark, grey corrugation)
  - light temperature: warm 50%, cool fluorescent 30%, tinted 20%
- **Sign hierarchy** (per 30 m of street frontage in Market; halve in Core, ×0.7 in Slum):
  - 1 large vertical blade, 8 to 20 m tall, starting above the canopy
  - 3 to 5 projecting signs, 1 to 3 m, at 4 to 9 m height, staggered so that no two adjacent signs share a height
  - every shop's fascia sign
  - 0 or 1 large screen (only on avenue faces)
  - brightness ranks: blades and screens 1.0, projecting signs 0.6, fascias 0.35
- **Cables.** One catenary every 6 to 12 m along narrow streets, at 5 to 9 m height, sag 4 to 12%. Market and Slum streets add a dense band of 3 to 6 cables. Lanterns hang on 30% of cables (Market only).
- **Ground clutter** (new, cheap instanced boxes): stalls 2×1.5 m with a lit top every 4 to 8 m on market streets, crates, bollards every 3 m on avenues, steam vents. The density is 1 item per 3 m of kerb in Market and Slum, 1 per 10 m in Core.
- **Podium upper floors** (6 to 24 m) must not show the giant blank panes in `street.png`. Use a 3 m mullion grid with spandrels, or car-park louvres.

**Podium and skybridges:**

- Podiums on one block align their tops to within ±1 podium floor, which makes a continuous street wall.
- Skybridges sit only at floor lines that exist on both buildings (snap to the lower common floor). They have 4 to 6 m depth and the same bay as the lower building. One per 150 m of street at most, staggered in height by at least 20 m.

**Neighbours:**

- Adjacent lots in one block share the district palette (1 or 2 wall tones + 1 accent).
- Heights next door differ by at least 15% *or* are equal within ±1 floor (equal = a twin). Avoid "almost equal".
- In Slum and Market, 30% of party walls are blank with a painted ad or a pipe bundle.

**Skyline:**

- Per superblock, rank buildings by height.
- At most 1 tower above `2×` the median.
- The tallest is placed at a block corner on an avenue intersection.
- Core landmarks (above 900 m) are at least 900 m apart.
- Height classes per superblock are 15% tall, 50% mid and 35% low. Low means at most 0.35× the tallest.
- Megablocks read as flat-topped plateaus. Their crowns are equipment, not spires.

---

## 8. Hero dressing along the flight path

- **The hero face:** a face whose normal points at an avenue (`FacadeSlot.avenue`) and whose segment centre is within 60 m of the avenue centreline. Set `SegFlags.Hero = 128`.
- **Hero faces get:**
  1. 1.5× the kit range
  2. catwalks at mech floors
  3. +1 tenant-variation tier (curtains, lit enclosures)
  4. a sign program from 0 to 120 m instead of 0 to 40 m: 1 vertical blade per 60 m of frontage at 40 to 120 m height, on the corner bay
  5. extra cables across the avenue at most every 150 m, below 120 m only
  6. AC condensate streaks in the shader
- **Prime band:** faces between 60 and 350 m altitude within 250 m of the camera. The full kit, including laundry, vents, cages and AC, extends to 250 m (from 240 to 360 m today).
- **Cheap elsewhere:**
  - Non-hero faces between 150 and 400 m: only ledges, pipes, balconies and enclosures.
  - Beyond 400 m: segment-scale massing (enclosure stacks, mech floors, crowns) and shader-only equivalents of AC and balconies, i.e. the existing `facade.wgsl` fakes, now drawn on the same bay grid.
  - Back faces (non-avenue, non-street): 50% presence probabilities.

---

## 9. Rooftops (`rooftops.ts` and the roof part of `cs_emit`)

- **Anchors.** Every roof has 1 or 2 **anchors**: the core penthouse (always over the C bays or at the centre) and, optionally, a secondary plant room at one end.
- **Clusters:**
  - HVAC units in **rows** of 2 to 6 along the long side of an anchor, 1.5 m apart, all the same size.
  - Tanks in a group of 2 to 6 on a raised steel deck (one segment) next to the core.
  - Vent stacks in rows of 3 to 6 along the penthouse wall.
  - Dishes and antennas on the parapet within 2 m of the edge.
- **Clear zones.**
  - 60% of the roof area stays empty: a membrane with paving, maintenance paths 1.5 m wide from the core to the cluster, and a 2 m clear band inside the parapet except for dishes.
  - The helipad stays clear and gets no "skylight" squares. Remove the random lit squares, or keep them only as a 2×4 skylight row over a C2 atrium.
- **Parapet.** 1.1 m on every exposed roof, with a coping. Glass and metal towers get a 3 to 6 m screen wall around the plant instead.
- **By district:** Slum gets shacks, antenna forests and tarps. Megablock gets tanks and a sign frame. Core gets a screen wall, a mast and a BMU crane (new, optional).

---

## 10. Lighting and colour script

This section sets light *budgets* (how much, where). Every *colour* value (hues, shares, haze tints, curtain and sign colours, including those in section 4) is set by the colour script in section 15, which wins on any conflict.

| District | Window lit % | Warm : cool : tinted | Neon budget | Edge strips | Haze |
|---|---|---|---|---|---|
| Core | 40% (office runs) | 30 : 60 : 10 | 1 crown light per tower; 1 ring set per landmark | only C3 landmarks, top 30%; ≤1 per superblock | thin, blue-grey; towers fade by 1.2 km |
| Megablock | 45% | 70 : 15 : 15 | sky-street strip + 1 roof sign | **none** | medium, warm-brown at the base |
| Slum | 50% | 60 : 20 green-fluoro : 20 | 1 small sign per building, at most 5 m wide | **none** | thick and low: steam and smoke to 60 m |
| Market | 55% | 50 : 20 : 30 | high: blades and projecting signs, as in section 7 | allowed only on K2 LED frames | coloured by signs; red-amber bounce (section 15) |
| Corporate | 25% | 90 amber : 10 | summit light, 1 logo | none | clean, sharp silhouettes |

- **District palette.** Each superblock has 1 dominant neon hue (60% of signs), 1 secondary (30%) and white or warm (10%). This keeps `setPalette`, enforced.
- **`FloorBands`.** Only at mechanical floors and sky streets. Never on every floor. At most 15% of towers.
- **`TopGlow`.** Only at the crown parapet, at most 20% of towers, and never on podiums (remove the podium default).
- **Base brightness.** Street level is the brightest layer: shopfronts make up 60% of the scene's emissive energy at street view. At flight altitude, 50% of the emissive energy should come from windows and 50% from signs.
- **Exposure target.** In a corridor chase shot, 25 to 35% of the frame's pixels belong to a lit window or sign. Neon edge strips may cover less than 3%.

---

## 11. Materials (`facade.wgsl`, `details.wgsl`)

| Material | Albedo (linear) | Roughness | Normal / pattern | Weathering |
|---|---|---|---|---|
| Board-formed concrete | 0.28 to 0.34 grey | 0.85 | 1.2 m form-tie grid, faint 0.15 m board lines | sill streaks 0.3 to 1.0 floor long, darker under each AC (40% darker, 0.4 m wide); splash 4 m |
| Painted concrete (HK) | pastel 0.35 to 0.45, 50% desaturated | 0.8 | as concrete | paint chalking (lighter top), streaks |
| Mosaic tile | white 0.55 / green 0.3 / salmon 0.4 | 0.4 | 0.05 m tile grid, visible within 30 m; missing-tile patches at p=0.05 per 1 m² | grime in the grout, streaks |
| Metal cladding | 0.15 to 0.22, metallic 0.7 | 0.45 | 3 m × floor panel seams, rivets within 20 m | rust bloom at panel bottoms and under pipes (orange 0.25, 0.12, 0.06) |
| Corrugated sheet (slum) | 0.2 to 0.35, mixed rust | 0.6 | 0.076 m corrugation | rust patches 30% |
| Curtain glass | 0.02 to 0.04, reflectivity 0.9 | 0.04 | 1.5 m modules; spandrel ribs | dirt at the bottom 10% of each pane |
| Basalt stone | 0.06 | 0.35 | 1.5×0.75 m joints | dark water streaks at the fins |
| Dark metal (kit) | 0.07 | 0.4 | none | rust at the brackets |

**Relief.** Every material has a relief profile in section 12, and its weathering masks read the same height. Grime collects in the low areas (joints and grout), and rust blooms from rivets and the bottoms of joints.

**Weathering logic.** Streak sources are kit positions: every AC, sill, ledge end and pipe collar. The shader recomputes these from the same bay grid, so there is no extra data. A streak is 0.4 m wide below an AC, 1.5 floors long, and 25 to 40% darker. A rust trail below metal brackets runs 0.8 m.
---

## 12. Surface relief (normal / parallax)

**Goal.** No wall may read as paint on a cube. Every frame, sill, joint and slat must catch light: a red sign 20 m away should draw a thin highlight along every sill and mullion edge on the wet facade, and grazing light should rake every panel joint.

Today `window_facade` already ray-traces the window opening and interior-maps the room. Every other surface is flat paint. The rules below layer on top of that.

### 12.1 Technique per feature class

| Technique | When to use it | Cost |
|---|---|---|
| **A. Analytic height profile → normal** | Grid-aligned features: frames, sills, mullions, spandrels, joints, louvres, shutters, corrugation, slab edges. Height is a closed-form function of `(bay frac, floor frac)`, so its gradient is exact and costs nothing to sample. | a few ALU |
| **B. Stepped analytic recess** (extends the existing trace) | Windows. The ray crosses four planes: wall face, then frame face, then glass. The sill plane is the bottom of the frame step. | +1 plane test |
| **C. Parallax occlusion mapping (POM)** on an analytic heightfield | Only where depth ≥ 0.06 m *and* the feature leaves see-through gaps: louvre bands, car-park louvres, deep precast reveals on hero faces | 8 to 16 steps |
| **D. Baked procedural atlas** (height, normal, roughness, AO) | Stochastic micro-detail that has no closed form: concrete pitting and board grain, rust bloom, tile chips, corrugation dents, grime masks | 1 to 2 texture fetches |

**Decision: hybrid.**

- Structure (A, B and C) stays analytic so that it lines up exactly with the bay grid of section 3 and is filtered by the same `aa_box` and `detail()` machinery.
- Micro-surface (D) comes from **one startup-baked atlas**:
  - Format: a compute pass writes a 2048² `rgba8` **texture_2d_array** with 2 layers. Layer 0 is height in R, roughness offset in G and AO in B. Layer 1 holds the normal in RG (octahedral).
  - Contents: 8 tileable 512² tiles, one per material in section 11.
  - It is fully mip-mapped (mips generated in the bake) and sampled with trilinear + anisotropic 8× filtering, so distance filtering comes for free.
  - It is world-projected on the facade: `uv = facade / tileMeters`, with tileMeters = 2 m for concrete, 1 m for tile and 3 m for metal.
- The same atlas also gives the **kit meshes** (`details.wgsl`, which already have UVs) their surface: AC bodies, pipe rust and canopy metal.
- Bake time budget: at most 30 ms.

### 12.2 Feature table (depth is relief height in meters; positive = proud of the wall)

| Feature | Profile | Depth | Technique | Typologies | Lighting behaviour |
|---|---|---|---|---|---|
| Window frame (alu or concrete surround) | 0.06 to 0.10 m wide band around the opening; 45° bevel 0.015 m on the outer edge | frame face −0.05 behind the wall (recessed frame), bevel ±0.015 | B for depth, A for the bevel | all windowed | The bevel throws a 1 to 2 px specular line in rain. The frame face is darker than the wall (reveal AO 0.7). |
| Sill | Lip 0.04 m tall, protruding +0.05, drip groove 0.01 underneath | +0.05 | A (normal: the top faces up, the front faces out) | M, S, K, C2 | The top catches sky and neon reflections (normal.y ≈ 1), so it is the brightest wet line on the facade. The underside is shadowed. |
| Mullion cap (curtain wall) | 0.06 m cap with 0.01 rounded edges, every 1.5 m module | +0.08 (geometry `fin` covers this within 650 m; beyond that, A) | A | C1, C4, podium glass | Thin vertical glints sweep as the camera moves. That sweep is the main "real glass tower" cue at 300 m. |
| Spandrel panel | Panel inset 0.03 m with a 0.02 m chamfer, plus 0.5 m horizontal ribs (existing) of 0.01 | −0.03, ribs ±0.01 | A | C1, K2 | Rib highlights stack in bands under neon. The chamfer edge picks up grazing light from street signs. |
| Precast panel joint | 0.02 m wide V-joint on the 3 m × floor grid (metal cladding) or 1.2 m × floor (precast) | −0.02 | A; C on hero faces within 25 m | M1 painted, C2, metal | Joints stay dark (AO 0.5) and fill with water first (see 12.4). |
| Board-formed concrete | 0.15 m board lines, plus form-tie holes Ø 0.03 on a 0.6 × 0.6 m grid | ±0.004 boards, −0.015 ties | A for the lines, D for the grain | Slum, M podium, C2 base | Visible only in grazing light: vertical sign light rakes the board lines. |
| Mosaic tile | 0.05 m tiles, 0.004 m grout, ±0.0015 random tile tilt | grout −0.003 | A for the grout grid, D for the tilt and chips | S1 (20%), M2, K1 | Sparkly but filtered: the tilt variance goes into roughness beyond 15 m (12.3). Wet tile reads as a broken mirror. |
| Corrugated metal | Sine of 0.076 m pitch, amplitude 0.009, vertical | ±0.009 | A (sine derivative) | S1 sheet, S2 rebuilt tiers, roof shacks | Strong anisotropic stripe highlights from point lights, which suits neon. Dents come from D. |
| Louvre band | Blades 0.15 m deep on a 0.2 m pitch, tilted 35°; gaps dark | −0.15 | C (12 steps), falling back to A beyond 40 m | C1 mech floors, M1 / M3 car parks | Each blade top catches light and the gaps go fully black. Seen from below (the street), the louvres close up. |
| Roller shutter | Slats 0.08 m tall, a 0.006 rounded hump each; bottom bar 0.06 | ±0.006 | A | closed shopfronts (15%) | Fine horizontal glint lines under the canopy light. |
| Balcony / slab edge | 0.02 chamfer on the top and bottom edges of `ledge` and `balcony` meshes, plus a 0.012 drip groove | chamfer 0.02 | Mesh: bevel quads or a normal tilt over the last 0.02 m in `details.wgsl` | M, S, K | Every floor gets a crisp highlight line, which gives the floors rhythm at 100 to 300 m. |
| Metal cladding panel | Pillowing ±0.003 at the panel centre, plus rivets Ø 0.02 every 0.3 m along the seams | ±0.003 | A for the seams and rivets, D for the pillow | C1 cores, metal | Soft oil-can reflections, the "AAA metal" cue. |
| Basalt stone joints | 0.008 joint on 1.5 × 0.75 m | −0.008 | A | C2, P1, P2 | Very subtle: it breaks up big dark mirrors. |

### 12.3 Distance and pixel-footprint fade (anti-aliasing)

- Each relief feature has a **feature width** `fwid`, e.g. bevel 0.015, joint 0.02, board 0.15, louvre 0.2.
- **Normal strength** is `k = detail(vec2(fwid), c.fw)`, the existing `smoothstep(2, 6 px)`. The perturbed normal is `normalize(mix(n, n_relief, k))`.
- **Variance goes into roughness, not aliasing.** When `k < 1`, the lost slope variance moves into roughness: `rough' = sqrt(rough² + (1 - k) * σ²)`, where σ² is the slope variance of the feature (bevels 0.05, corrugation 0.08, tile tilt 0.02, louvres 0.15). This keeps the wet-street specular from sparkling at 300 m and makes distant louvre bands read as a rougher, darker band.
- **AO terms** (joints, grout, frame) fade to their *area-weighted average*, not to 1. Use the same rule as `aa_box`: a 0.02 joint on a 3 m panel averages to 0.993 × the joint AO.
- **POM budget:**
  - Steps = `clamp(16 * (1 - |viewT.z|), 6, 16)`.
  - Enabled only when the pixel footprint < 0.02 m and the distance < 40 m (raise to 60 m for the hero band).
  - Within the last 20% of the range, blend to technique A to avoid popping.
  - No POM self-shadowing. Use AO only.
- **Atlas:** mip selection handles distance. Clamp the normal-map intensity by `detail(vec2(tileMeters/64), fw)` so mip-averaged normals don't flatten unevenly.
- **TAA:** relief normals must be deterministic (no time noise). The sub-pixel jitter of TAA resolves features of 1 to 2 px. Never sharpen normals below 2 px.

### 12.4 Rain interaction (`apply_wet`)

- Wetness is higher in low height. Joints, grout and frame recesses reach full wetness first (roughness 0.05), then the flat faces follow (roughness 0.15 to 0.3).
- Sill tops and slab-edge tops get standing-water specular: roughness 0.03, as on ground puddles.
- The water-sheeting streaks in `apply_wet` follow the joint lines: streak intensity ×1.5 within 0.05 m below each horizontal joint or sill.
- The grazing light from blade signs (vertical sources 1 to 4 m off the wall) is the showcase. The relief normal must feed every light, including clustered sign lights, not just the sun or moon.

### 12.5 Per typology summary

| Typology | Mandatory relief |
|---|---|
| C1 | mullion caps, spandrel inset and ribs, recessed frames, louvre POM on mech floors (hero), cladding seams on cores |
| C2, P2 | stone joints, deep fin chamfers, strip-window frames |
| C3 | facet joints every 3 m, ring-band chamfers |
| M1, M2, M3 | concrete frames and sills, painted precast joints, balcony edge chamfers, car-park louvres, tile on 30% of M2 |
| S1, S2, S3 | sills, board-formed concrete, tile (20%), corrugated sheet on enclosures and rebuilt tiers, rust from the atlas |
| K1, K2, K3 | frames, sills, shutters on closed shops, LED-frame border chamfer, tile on 30% of K1 |

---

## 13. Priorities and phasing

1. **Shared bay grid** (TS + `segment.wgsl` + `facade.wgsl` + `details_emit.wgsl`).
   - Encode bay and typology in the colour alphas.
   - Snap face widths. Make the corridor shrink drop bays.
   - Add one `bay_of()` and delete the private grids. The slum bay is fixed per building.
   - Payoff: AC units, cages and balconies line up with windows everywhere.
2. **Kill the willy-nilly** (`details_emit.wgsl`, `buildings.ts`).
   - Retire random `module` placement and the random service shafts.
   - Rewrite `kitbashTier` as bay-snapped enclosure stacks with the host style.
   - Column→unit→cell hashing (section 6). Rhythm strings per typology.
3. **Light budget** (`generate.ts`, `buildings.ts`, `facade.wgsl`).
   - Strip `EdgeGlow`, `FloorBands` and `TopGlow` down to the table in section 10.
   - Office lit runs per floor.
   - The cheapest change with the biggest effect on the "2002" read.
4. **Typology massing** (`buildings.ts`, `generate.ts`).
   - C1 mechanical floors and bay setbacks; M1 sky streets; M2 cruciform light wells; S1 tenement rows with fixed bays; K1 sign towers.
   - Typology ids feed the rhythm table.
5. **Surface relief, part 1** (`facade.wgsl`, `lighting.wgsl` inputs).
   - The stepped window recess with frame and sill (technique B).
   - Analytic normals for sills, mullion caps, spandrels, joints, shutters and corrugation (A).
   - Roughness-variance fade (12.3) and wet-joint behaviour (12.4).
   - Bevel chamfers on the `ledge` and `balcony` meshes.
   - This directly answers the "painted on a cube" complaint at all distances.
6. **Street layer** (`details_emit.wgsl` canopy redesign, `signs.ts` hierarchy, new clutter instances, `cables` density).
7. **Rooftop clusters** (`rooftops.ts` anchors, plus a rewrite of the roof section of `cs_emit` as rows and clusters).
8. **Hero dressing** (the Hero flag in `generate.ts`, range multipliers, catwalks, hero signs).
9. **Surface relief, part 2.**
   - The startup-baked material atlas (12.1 D), used by the facades and the kit meshes.
   - Louvre POM on hero faces.
   - Weathering tied to the kit grid (`facade.wgsl`).
   - New parts: laundry, louvre, catwalk.

---

## 14. Review checklist (yes/no, on screenshots)

1. On residential towers, do AC units, cages and balconies sit in **vertical stacks** that line up with window bays (no unit half off a window)?
2. Is there **no** bolted-on box whose edges fail to line up with the window grid of its host?
3. Does every tall building show a distinct **base, shaft and crown**, with the base visibly busier and warmer?
4. In chase shots, do neon edge strips cover less than about 3% of the frame, with no residential or slum building outlined in neon, and glow bands only on a few mechanical floors or sky streets?
5. Up close (within 40 m, `facade.png` or `street.png` framing), do window frames, sills, mullions and panel joints show **real relief**: a highlight on the top or lit edges, a shadow or dark line on the recessed side, and a shift as the camera moves, with no shimmer or sparkle at distance? Does neon or sign light visibly rake across them on wet walls?
6. Do glass office towers show mid-scale relief at 300 m (mechanical floor bands, piers, a crown lattice), and not just a window texture?
7. Are office lights lit in **whole-floor runs** rather than salt-and-pepper?
8. Are the pattern breaks on a residential facade whole units or whole columns (an enclosed balcony, a repainted band), not random jitter?
9. Are rooftop props **clustered** around a penthouse or core, with clear paths and empty roof area, not spread evenly?
10. At street level, do shopfronts vary in canopy depth, sign size and height, with at least 3 sign sizes visible and blade signs above the canopies?
11. Do cables, lanterns or stalls fill the street canyon in Market and Slum shots?
12. Can each district be told apart from a single shot by its massing **and** its light mix (section 15.3: gold Corporate, sodium Megablock, smoky tungsten Slum, red Market, xenon-and-tungsten Core), while all five still read as one film?
13. In skyline shots, are there clear height classes, with landmarks spaced apart and not a forest of equal towers?
14. Do slum buildings differ *from each other* (bay widths, tones, floor lines) while each one is internally consistent?
15. Are the windows on corner bays whole: no clipped half-windows at building edges?
16. **Colour: atmosphere.** Is the sky and haze amber-brown low and near, and grey-steel high and far, with **no violet or magenta cast** anywhere in the haze, sky or shadows (sample the sky at the horizon and at 30° up: hue between 20° and 40° low, saturation below 15% high)?
17. **Colour: intent.** Is at least 60% of the emitted light warm (sodium, tungsten, red, warm white)? Does every magenta, cyan, green or violet accent belong to a place (a Market magenta block, a Core landmark crown, one Slum sign per tenement, a hologram), clustered rather than sprinkled, with one accent story leading the frame?
18. **Colour: blocks.** Within one block, do the signs show one dominant hue plus one secondary, so that you could name the block's colour in one word? Is no frame a confetti of five or more sign hues?
19. **Colour: grade.** Do the brightest sources (beams, headlights, sign cores, flares) roll off to warm or neutral white instead of clipping to a saturated colour, with no tinted anamorphic streaks (streaks take their source's colour), and are the deepest shadows near-neutral rather than teal or purple?

---

## 15. Colour script

### 15.0 What the films actually do (and what we got wrong)

- **Blade Runner (1982).** Cronenweth wanted *Citizen Kane*: high contrast, hard backlight and shafts of light, so the sets were filled with smoke ("just before I lose consciousness") and lit through it. The aerial "surveillance" beams were **xenon** advertising searchlights; on tungsten-balanced film they read **blue-white**. Street neons sat on dimmers "just above where they would start to flicker", and the crowds were dressed "rather colorless" (ASC, *Blade Runner: Cronenweth's Photography*). The Tyrell office is **amber**: arcs through amber gels behind a sunrise plate. The Hades opening is etched-brass miniatures lit from below by thousands of fibre-optic pinpoints (white and amber), in layers of smoke, with **orange gas-flare fireballs** projected into the miniature (Trumbull / EEG). The ads (Coca-Cola, Atari, TDK, Pan Am, the geisha) are mostly corporate **red and white** plus skin tones; Pan Am's blue globe is the one cool logo. The street neon is mostly red and warm white, with a few green and blue tubes, kept dim.
- **Blade Runner 2049.** Deakins's Los Angeles is grey, rain- and snow-soaked and desaturated. The only strong colour is the ads: the Joi advert is **pink and blue** and "was basically lighting the whole shot". Las Vegas is an orange monochrome (Lee 105 Orange plus Moroccan Pink, Golden Amber on skylights). Wallace's spaces are amber water caustics.
- **Correction (refined by the user).** The point is not that cyberpunk accents are forbidden; it is that we used them as a **crutch**: every sign rolled a random saturated hue, and the whole atmosphere was tinted violet, so no colour meant anything. In both films the saturated colours are rare, **placed**, and carry meaning (the red Coca-Cola wall, Joi's pink-and-blue). So: keep magenta, cyan and green, but give each one an owner, a place and a budget (15.2b). The atmosphere is never an accent colour by default.

**What reads as random in our build** (out/review-s13):

1. **A violet bath.** The sky horizon `(0.13, 0.06, 0.11)`, `fogColor (0.06, 0.035, 0.055)`, ambient sky `(0.26, 0.18, 0.34)` and the reflection horizon `(0.11, 0.05, 0.075)` are all magenta-purple. Every frame (`chase-030`, `chase-060`, `skyline-200`) sits in purple haze that no reference has.
2. **Hue confetti.** `NEON` holds 8 equal-saturation hues. `setPalette` picks any of them per 3×3 superblocks, and `slotPalette` adds a wildcard from all 8. `skyline-200` shows pink, green, amber, cyan and violet rings side by side with no dominant.
3. **Five unrelated palettes.** `NEON`, rooftop `NEONS`, WGSL `neon_accent`, `LANTERN_COLORS` and the facade's `tinted` colours are separate lists, plus ads and holograms that `rng.pick(NEON)` twice.
4. **Cool used as an effect.** The anamorphic streak is tinted `(0.35, 0.55, 1.0)` (the cyan bars in `chase-060` and `slum1`), and the grade pushes shadows teal.
5. **Five films.** The district haze tints swing hue by ±35% (Market magenta, Slum green, Core blue).
6. **Candy windows.** Pink and teal rooms, saturated TV blue and `(0.62, 1, 0.72)` green fluoro (`slum1`).

### 15.1 Concept and value structure

*A sodium city under a smoke ceiling. It is lit from below by amber and tungsten practicals, cut from above by blue-white xenon beams, and red is its only shout.* Warm lives low and near, and cool lives high and far. Colour saturation is spent only on red signs and on the rare hologram.

- **Darkest:** the unlit mid-height masses of buildings (soot, about 0.004 linear) and the zenith.
- **Brightest:** the canyon floor (shopfronts and lamps), beam cores, and flare and sign cores.
- **Contrast lives in silhouette:** dark towers against lit haze, and smoke backlit by beams, not hue against hue. A frame must still read in greyscale.

### 15.2 Master palette

All code values are **linear**. Energy share is the share of the frame's emissive energy in a chase shot at flight altitude, with the street-view share in brackets.

| # | Name | sRGB | Linear | Role | Energy share |
|---|---|---|---|---|---|
| A1 | Smog Amber | `#5A4030` | 0.102, 0.051, 0.030 | low and near haze, horizon glow, cloud underside | atmosphere |
| A2 | Rain Steel | `#46505A` | 0.061, 0.080, 0.102 | high and far haze, top-face ambient, distant silhouettes | atmosphere |
| A3 | Soot | `#0E0F12` | 0.004, 0.005, 0.006 | zenith, unlit masses, deepest shadow | none |
| P1 | Sodium | `#FF9A3C` | 1.0, 0.323, 0.045 | street lamps, Megablock windows, canyon bounce, Corporate gold | 25% (20%) |
| P2 | Tungsten | `#FFB46B` | 1.0, 0.456, 0.147 | windows, shop interiors, lanterns | 30% (35%) |
| P3 | Xenon | `#DCE8FF` | 0.716, 0.807, 1.0 | searchlights, spinner and car beams, office fluorescents | 15% (8%) |
| X1 | Signal Red | `#FF3A22` | 1.0, 0.042, 0.016 | the sign colour; tail lights, beacons, ads | 15% (20%) |
| X2 | Neon White | `#FFDDB0` | 1.0, 0.723, 0.434 | warm-white tube lettering, fascias, screen text | 8% (12%) |
| X3 | Holo Rose + Holo Ice | `#D98CA0` + `#8FB4C8` | 0.694, 0.262, 0.352 + 0.275, 0.456, 0.578 | **a pair**, used only together, on holograms and some screens | 5% (5%) |

**Derived tints.** These are not new hues and may only be used where named. They must stay at 2% or less of the energy.

- Fluoro `#D8F0D8` (0.687, 0.871, 0.687): Slum interiors only.
- TV Blue `#8C9EC8` (0.262, 0.342, 0.578): flicker inside rooms only.
- Flare `#FF7A1E` (1.0, 0.195, 0.013): Hades flare stacks only.
- Tube Green `#86C89A` (0.238, 0.578, 0.323): at most 1 Market tube sign per block.

Everything warm (P1, P2, X1, X2) totals at least **60%** of the energy; accents follow 15.2b.

### 15.2b Accents with intent

The cyberpunk accents stay, as **signatures**: each belongs to a district or a landmark, appears **clustered** (a block, a building, a hologram), and is never rolled per sign.

| # | Name | sRGB | Linear | Owner and place | Budget |
|---|---|---|---|---|---|
| K1 | Electric Magenta | `#FF2D95` | 1.0, 0.026, 0.30 | **Market**: the dominant sign hue of about 1 Market block in 3; Market LED skins; the giant route holograms (with Ice) | ≤ 12% |
| K2 | Data Cyan | `#2EE6FF` | 0.027, 0.79, 1.0 | **Core**: crown lights and data screens on landmark towers; secondary sign hue in Market magenta blocks | ≤ 8% |
| K3 | Acid Green | `#7CFF5A` | 0.20, 1.0, 0.10 | **Slum**: one small sign per tenement (pharmacy crosses, noodle bars) and green fluoro rooms | ≤ 5% |
| K4 | Ultraviolet | `#8A4DFF` | 0.25, 0.074, 1.0 | **Landmarks only**: at most one per view (a hologram or one crown) | ≤ 3% |

Rules:
- **Cluster, don't sprinkle.** An accent appears as a whole block's palette, one building's program or one landmark, so it reads as a *place*. A lone random accent sign is a bug.
- **One accent story per frame.** The district under the camera decides which accent leads; others appear only in the distance.
- **Accents total ≤ 25%** of emitted energy in any frame, and warm (P1, P2, X1, X2) stays ≥ 60%.
- **Motivated colour only in the air.** Haze takes an accent only as *bounce* below about 60 m from a big source of it (a Market canyon glows magenta-red near the street); never as a global tint.
- Accents never tint the grade, the ambient light or the streaks.

### 15.3 Districts (one film, five mixes)

Shares are of the district's practical and sign energy. The haze tint multiplies the base fog colour and must stay within ±15% per channel of 1.0.

| District | Mix | Haze tint (`district_tint`) | Read |
|---|---|---|---|
| Core | Tungsten 35, Xenon 30, Sodium 10, Red 10 (beacons), Cyan 8 (landmark crowns, screens), Holo 7 | `(0.94, 0.98, 1.06)` | the coolest district: xenon offices, beams on crowns |
| Megablock | Sodium 45, Tungsten 35, Xenon 8, Red 12 | `(1.08, 1.0, 0.9)` | sodium-brown plateaus |
| Slum | Tungsten 45, Fluoro 15, Sodium 20, Red 12, Acid Green 8 (one sign per tenement) | `(1.04, 1.0, 0.9)`, density ×1.4 below 60 m | smoky and dim, with one red sign per building |
| Market | red blocks: Red 35, Tungsten 25, Sodium 15, Neon White 15, Holo 10; magenta blocks (1 in 3): Magenta 35, Cyan 15, Neon White 20, Tungsten 30 | `(1.12, 0.97, 0.9)` | a red canyon (the BR street) |
| Corporate | Sodium-gold 60 (Tyrell), Xenon 30 (searchlights), Red 10 (beacons) | `(1.06, 1.0, 0.94)`, density ×0.7 | gold pyramids raked by white beams |

### 15.4 Signage rules

Sign set: **Red, Sodium (amber), Neon White, Holo Ice**, plus Tube Green in Market only.

| Sign kind (brightness rank, section 7) | Red | Neon White | Amber | Ice | Green |
|---|---|---|---|---|---|
| Blades and screens (1.0) | 45 | 30 | 15 | 10 | 0 |
| Projecting signs (0.6) | 40 | 25 | 30 | 0 | ≤5 (Market) |
| Fascias (0.35) | 20 | 50 | 25 | 5 | 0 |

- **Block rule.** Each superblock rolls one **dominant** from {Red 0.5, Amber 0.3, Neon White 0.2} and one **secondary**, which is a different member of that set or Ice (p=0.15). Then signs are dominant 60%, secondary 30%, and the size table above 10%. There is no global wildcard.
- **Text versus body.** Glyphs are Neon White or the sign hue. The sign body or border is the *other* one, never two saturated hues on one sign.
- **Accents only by block.** Magenta and cyan appear as the dominant and secondary of a Market *magenta block*, green as the one Slum sign per tenement, cyan on Core landmark crowns (15.2b). Never as a per-sign roll.
- **Dim the street.** Neon tube peak is at most 2.5× a lit window's luminance (Cronenweth's "just above flicker"). Blades may reach 4×.

### 15.5 Atmosphere

- **Fog colour by altitude.** World y below 80 m: Smog Amber. From 80 to 400 m: lerp to a neutral umber-grey `(0.07, 0.06, 0.055)`. Above 400 m, or beyond 1.5 km distance: Rain Steel. Looking down into canyons, fog goes *warmer and brighter*, because it is lit sodium.
- **Sky.**
  - Horizon `(0.10, 0.06, 0.035)`, mid `(0.03, 0.026, 0.024)`, zenith `(0.004, 0.005, 0.007)`.
  - The cloud underside is lit amber near the horizon `(0.20, 0.11, 0.05)` and fades to steel overhead `(0.045, 0.048, 0.055)`.
  - The sky and fog carry no violet or magenta wash; any accent in the air is motivated bounce (15.2b).
- **Beams (new).** Xenon searchlights, 3 to 6 per km², from Corporate and Core crowns, with slow sweeps of 0.05 to 0.15 rad/s. The volumetric colour is `(0.72, 0.81, 1.0)`. Beams are the main source of cool light in the frame, and they backlight the smoke.
- **Hades flares (new, optional).** Refinery stacks on the city edge burst Flare orange every 8 to 20 s and light the cloud underside within 1.5 km.

### 15.6 Practicals

- **Windows:**
  - Residential: Tungsten 60, Sodium 15, Xenon-fluoro 15, TV Blue flicker 7, curtain 3. Curtains are ochre, rust or faded red, never pink or teal.
  - Office: Xenon 55, Tungsten 40, TV 5.
  - Slum: Tungsten 50, Fluoro 25, Sodium 15, curtain 10.
  - Monolith and Corporate: Sodium-gold 90, Xenon 10.
- **Shopfronts:** Tungsten 55, Xenon-fluoro 30, sign-set hue 15.
- **Street lamps:** 85% sodium, 15% mercury xenon.
- **Traffic:**
  - Head lights are xenon. Tail lights are Red.
  - The `kind 4` emissive becomes xenon at 0.5.
  - The taxi body stays yellow (a surface colour, not light).
- **Aircraft beacons:** Red only, blinking at 0.5 to 1 Hz, on masts and crowns.
- **Helipad perimeter lights:** sodium-yellow, not green.
- **Hero car:**
  - Head lights are xenon, and tail lights are red.
  - The lift and thruster light is sodium-amber.
  - The light bar is xenon plus red, as on a BR police spinner.
  - The underglow is amber, not blue.
  - The dash is amber monochrome CRT plus one dim green-phosphor panel. Drop the teal grid.
- **Lanterns:** red and tungsten only.

### 15.7 Ads and holograms

**Screens and LED facades.** These are the **only** place Holo Rose and Ice may be large. Values must stay at 1.2 or less before bloom.

| Scene | colA | colB | Background |
|---|---|---|---|
| 0 bottle (the Coke ad) | Red | Neon White | deep red-brown `(0.08, 0.01, 0.005)` |
| 1 dancer (Joi) | Holo Rose | Holo Ice | near-black steel |
| 2 koi | Red | Tungsten | black |
| 3 face (geisha) | Red | Neon White | black; skin, red lips, black hair as now |
| 4 noodles | Tungsten | Red | dark brown |
| 5 pharma | Holo Ice | Neon White | dark steel |
| 6 jellyfish | Holo Ice | Holo Rose | black |
| 7 logo | Neon White | Red | black |

**Holograms.**

- Colours come only from the hologram pair (Rose and Ice), or Neon White and Red for the logo, desaturated to a saturation of 0.45 or less.
- Draw them at 60% additive opacity with a white core (mix 0.3).
- The giant route holograms alternate face/Rose-led and dancer/Ice-led, so you never see two different pairs in one view.

### 15.8 Grade (`tonemap.wgsl`)

- **Keep AgX.** Change the split toning:
  - Shadows to near-neutral steel `(0.97, 1.0, 1.03)` (from the teal `0.85, 1.0, 1.12`).
  - Highlights to warm `(1.04, 1.0, 0.92)`.
- **Saturation.** Global ×0.88 in display space. Above luminance 0.75, ramp the saturation down to 0.4, so that sign and beam cores roll off to warm or neutral white the way film does.
- **No clamp.** Accents are controlled at the source (15.2b), not in the grade.
- **Streaks and bloom.** The anamorphic streak takes the **source colour** × `(1.0, 0.95, 0.9)`, instead of the fixed `(0.35, 0.55, 1.0)`. Keep the bloom mix at 0.12.
- **Grain.** Keep the 0.025 grain. Black level must stay at 0.004 or below. Never lift the shadows with colour.

### 15.9 Code mapping (priority order)

| # | Location | Change |
|---|---|---|
| 1 | `main.ts` `fogColor` | `[0.06, 0.035, 0.055]` → `[0.05, 0.035, 0.022]` (Smog Amber ×0.5) |
| 2 | `sky.wgsl` `sky_color` | horizon, mid, zenith and cloud glow per 15.5; the below-horizon colour `(0.14, 0.06, 0.04)` → `(0.12, 0.07, 0.035)` |
| 3 | `sky.wgsl` `fog_color` | add the altitude and distance lerp: Smog Amber (y < 80) → umber-grey → Rain Steel (y > 400 or d > 1.5 km); `fog_color` takes the distance |
| 4 | `lighting.wgsl` `ambient_light` | sky `(0.26, 0.18, 0.34)` → `(0.17, 0.18, 0.2)` (cool from above); horizon `(0.24, 0.16, 0.22)` → `(0.2, 0.16, 0.12)`; ground stays `(0.2, 0.1, 0.06)` |
| 5 | `lighting.wgsl` `reflection_env` | horizon `(0.11, 0.05, 0.075)` → `(0.10, 0.06, 0.035)`; above `(0.016, 0.013, 0.028)` → `(0.014, 0.016, 0.02)` |
| 6 | `buildings.ts` `NEON` | replace with the sign set `SIGN = {red, amber(sodium), white(Neon White), ice, green}` in linear values from 15.2; export a `HOLO = {rose, ice}` pair; delete magenta, violet, pink, gold and cyan |
| 7 | `generate.ts` palette block and `setPalette` | per superblock: dominant from {red .5, amber .3, white .2}; secondary is another member or ice (p=0.15); weights `[6, 3, 1]` with the 10% slot drawn from the size table |
| 8 | `signs.ts` `slotPalette` | use the same hash as #7 (share one `blockPalette(i, j)` function); remove the `rng.int(0, 8)` wildcard; take a `kind` argument (blade, projecting or fascia) and apply the 15.4 table; `col2` is Neon White when `col` is saturated |
| 9 | `tonemap.wgsl` | split-tone, saturation roll-off and violet clamp per 15.8; streak tint `(0.35, 0.55, 1.0)` → source colour × `(1.0, 0.95, 0.9)` |
| 10 | `composite.wgsl` `district_tint` | the 15.3 values (Core `0.94, 0.98, 1.06`; Megablock `1.08, 1.0, 0.9`; Slum `1.04, 1.0, 0.9`; Market `1.12, 0.97, 0.9`; Corporate `1.06, 1.0, 0.94`) |
| 11 | `facade.wgsl` `light_color` | warm `(1, 0.64, 0.34)` → Tungsten `(1, 0.456, 0.147)`, and the 30% tint mix → Sodium; cool → Xenon; fluoro `(0.62, 1, 0.72)` → `(0.69, 0.87, 0.69)`; tinted pink and teal → curtain rust `(0.8, 0.3, 0.12)` / ochre `(0.75, 0.5, 0.15)`; tv `(0.4, 0.5, 1)` → `(0.26, 0.34, 0.58)`; shares per 15.6 |
| 12 | `facade.wgsl` shopfront | `shopCol` warm → Tungsten, cool → Xenon; the "tinted" branch `unpack_color(hash)` → a sign-set colour from the block palette; shutter graffiti → {red, ochre, white} ×0.4; TV flicker `(0.25, 0.35, 0.9)` → TV Blue |
| 13 | `ads.ts` tiles | `colorA/B` from the 15.7 table by `scene`, not `rng.pick(NEON)` |
| 14 | `ads.ts` holograms | `color/color2` = the HOLO pair (logo: Neon White/Red); `hologram.wgsl` desaturates to 0.45 or less |
| 15 | `details_emit.wgsl` `neon_accent` | becomes `sign_accent(h)`: red .45, amber .3, white .25. Enclosure windows (`details.wgsl` part 3) use window light (Tungsten 70 / Fluoro 30) instead. AC LEDs are red or amber. Awning fabric uses `laundry_color` |
| 16 | `details_emit.wgsl` `laundry_color` | random RGB → pick from fabric {indigo `0.08, 0.1, 0.18`, rust `0.35, 0.12, 0.05`, ochre `0.45, 0.32, 0.1`, faded red `0.4, 0.08, 0.06`, off-white `0.6, 0.58, 0.52`, grey `0.3`} |
| 17 | `signs.ts` street lamps | 70/30 → 85/15; warm `[5, 2.6, 1]` → `[5, 1.6, 0.23]` (Sodium); cool `[2.2, 3.4, 5]` → `[3.6, 4, 5]` (Xenon) |
| 18 | `buildings.ts` `pearlTower`, `ledSlab` | the magenta `colorB (1, 0.15, 0.6)` → Red; pink `colorA` → Neon White; `ledSlab` `neon(r)` ×2 → the ad pairs of 15.7 |
| 19 | `facade.wgsl` `ST_NEONRING`, `F_BANDS`, `F_TOPGLOW`, `F_EDGE` | the accent must be Red, Neon White, Sodium or Xenon (assert in TS when packing `colorB` for these flags) |
| 20 | `rooftops.ts` `NEONS`, `neonPair` | delete; billboards use the 15.7 ad pairs; shack windows stay Tungsten |
| 21 | `render/cables.ts` `LANTERN_COLORS` | `[1, 0.22, 0.5]` (pink) → Tungsten; keep red, amber and warm |
| 22 | `traffic.wgsl` | head `(10, 9, 7.5)` → Xenon ×10; the `kind 4` emissive `(0.2, 0.5, 0.8)` → Xenon ×0.5; tail stays |
| 23 | `carRenderer.ts` `carLights`, `spinner.ts` | headlights `[16, 15, 13]` → `[11.5, 13, 16]`; underglow `(0.8, 2, 4)` → `[3, 1.6, 0.5]`; `HEAD [6, 5, 4]` → `[4.3, 4.8, 6]`; `CYAN [0.4, 5, 7]` → Xenon `[4.3, 4.8, 6]`; `car.wgsl` dash teal `(0, 0.35, 0.55)` → amber CRT `(0.5, 0.2, 0.03)` |
| 24 | `facade.wgsl` helipad dots | `(0.2, 1, 0.4)` → Sodium |
| 25 | new: `volumetric.wgsl` / lights | xenon searchlight beams (15.5); optional Hades flares |
