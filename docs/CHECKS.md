# Homeward: checks and fixes

Expect about 60 stills (15 images, 4 variants each) and 30 clip takes (27 without c03). Most of the effort goes into picking, so judge each take against this table before you export its last frame.

| Clip | Look at | Common failure | Fix |
| --- | --- | --- | --- |
| c01 | Same face and clothes from start to end, steady pace, feet on the ground | The face changes during the arc; feet slide | Attach A0; split the arc into two clips through K02; regenerate |
| c02 | Pupil dead centre at the end; the eye keeps its shape through the blink | The eye warps; the pupil drifts | Keep it to 5 s; add: the eye does not change shape; pick the steadiest iris |
| c03 | The valley matches K05, the house is centred | A fog-machine look; no house | Skip the clip and use the portal join |
| c04 | The house stays dead centre; the zoom never reverses | The house drifts sideways; a second house appears | Repeat: forward motion only, the house stays in the exact centre; try 8 s; or split into two 5 s clips at a midpoint frame |
| c05 | The room matches A2; nobody appears | The door morphs; a person appears | Add: no people; attach A2; shorten the final turn |
| c06 | Only a hand and sleeve; the book keeps its cover and emblem | Extra fingers; the cover changes colour | Make the hand smaller in the frame; end the clip as the book is set down and start c07 from there |
| c07 | Pages turn in order; the last spread equals K09 | Pages flicker; the final page is wrong | Use the end frame; or split into 5 s of turning and 3 s of settling |
| c08 | The horizon holds its height; the border leaves the frame | The border dissolves instead of sliding; the sea looks flat | Use plan B below |
| c09 | People move naturally | Faces melt in the distance | Keep people small; add: no close-ups; use fewer people |
| c10 | Clean sky | Specks or objects in the sky | Add: nothing but sky; shorten to 4 s |

**Plan B for c08.** If the model will not slide the paper away, ask for less and let the site finish the move. Give it only the start frame K09:

```text
{STYLE} The sea in the photograph comes alive inside the open book: the waves move, foam rolls in, sunlight glitters on the water. The camera pushes slowly toward the photograph. The book stays where it is and the paper does not move. No cuts.
```

In story.ts keep c08's join as rect. The site then grows the photograph's rectangle to fill the screen and lands on c09's first frame, K10.

**After import.** Run npm run art:check. OK means leave it. WARN means the site's join will hide the mismatch. FAIL means regenerate the later clip from the earlier clip's real last frame, or change the join type for that pair.

**Readable text.** Models invent letters, and at 1080p they read as texture, which is right for the library and the flying pages. If one line must be readable, set it yourself: ask Claude to lay the page out as an HTML page, screenshot it, and use that image as the start or reference frame for c06.
