# Homeward: the plan and the shot list

Homeward is a scroll-driven film in ten clips: the visitor's scroll plays it forward and back, and every clip ends on the frame the next one starts with, so one camera seems to travel from a road, through an eye, down into a house, into a book, out to sea and up to the sky.

**The one idea.** Nothing is cut; everything is matched. The road ends on a face, the face on an eye, the eye opens onto a valley, the valley narrows to a door, the door opens onto a shelf, the book opens onto a sea, the sea turns real. So you make the stills first, as a storyboard where each frame closes one clip and opens the next, then animate between neighbours. Where a video model cannot hold a join, the website hides it with a short shader transition built on the same frames.

**Order of work**

1. docs/STYLE-BIBLE.md and art/prompts.json: lock the style, the man and the place.
2. docs/IMAGE-PROMPTS.md: generate the reference images A0 to A2 and keyframes K01 to K12, in order.
3. docs/VIDEO-PROMPTS.md: animate ten clips between the keyframes, three takes each, chaining from each chosen take's real last frame.
4. docs/EXTRA-ASSETS.md: make the extras: overlays, sound, phone re-frames, poster.
5. docs/EXPORT.md: run the import script from website phase 2; it builds the frame sequences and checks every join.
6. docs/ARCHITECTURE.md and prompts/: build the site with the eight phase prompts; it runs on placeholders until your art arrives.

**What I assumed**

- Working title Homeward, and a pure storytelling scroll with no sales message; docs/COPY.md has placeholder copy.
- A warm hill village at golden hour. The regional look is one paragraph in the style bible (REGION), so you can swap it.
- The monument is invented, not a real landmark; name a real one in K08 if you prefer.
- Your tools: an image generator that takes reference images, and a video generator that takes a start frame and ideally an end frame. Prompts are plain English and tool-neutral.
- 16:9 for desktop, composed so the centre third survives a 9:16 crop on phones.

## Shot list

Ten clips make about 73 seconds of film, spread over 950 viewport-heights of scroll (about 13 vh per second) plus one 100 vh end screen. Without the optional c03 it is 67 seconds and 870 vh.

| # | Clip | Film s | Scroll vh | Frames kept | Keyframes | What the camera does | Join into next |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | c01-follow | 8 | 100 | 60 | K01 to K03 | Tracks him from behind, closes in, arcs round his shoulder to his face | push |
| 2 | c02-eye | 5 | 70 | 42 | K03 to K04 | Straight push-in from face to a macro of the eye, pupil dead centre | portal, or push if c03 exists |
| 3 | c03-portal (optional) | 6 | 80 | 48 | K04 to K05 | The pupil opens onto the valley. The site can make this join itself, so generate it only if you want a video version | push |
| 4 | c04-descent | 10 | 130 | 78 | K05 to K06 | One steady zoom from far above the valley down to the open door; the house never leaves the centre | push |
| 5 | c05-enter | 8 | 100 | 60 | K06 to K07 | Dolly through the door, turn to the library wall, stop on one book | push |
| 6 | c06-book | 6 | 80 | 48 | K07 to K08 | Follows the book to the reading desk, then cranes to a top-down view as it opens | push |
| 7 | c07-pages | 8 | 110 | 66 | K08 to K09 | Pages turn one after another and settle on the sea photograph | push |
| 8 | c08-sea-alive | 8 | 100 | 60 | K09 to K10 | Pushes into the photograph as the sea comes alive and the paper slides away | rect if c08 stays inside the book, otherwise push |
| 9 | c09-shore | 8 | 100 | 60 | K10 to K11 | Skims over the water to a shore with people | push |
| 10 | c10-sky | 6 | 80 | 48 | K11 to K12 | Tilts up from the water and the people into the sky | none (end screen) |

**The three joins.** push is a short zoom-blur cross-dissolve, portal is a circular reveal that opens from the pupil, and rect grows the photograph's rectangle until it fills the screen. Each lasts about 12 frames, which is enough to hide a small mismatch between one clip's last frame and the next one's first. Film seconds are targets: a clip the tool cuts shorter simply plays faster against the same scroll.

**Frames kept** is scroll vh times 0.6, rounded to match the table in docs/EXPORT.md. The site blends neighbouring frames, so that density scrubs smoothly.
