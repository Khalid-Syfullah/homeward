# Homeward: asset manifest and export

Drop the finished files into these folders and website phase 2 turns them into the frame sequences the site plays. The commands below are the reference for what that script does, so you can also run them by hand.

```text
art/
  source/
    refs/        A0.png  A1.png  A2.png
    keyframes/   K01.png ... K12.png
    clips/       c01-follow.mp4 ... c10-sky.mp4   (c03-portal.mp4 is optional)
    overlays/    dust.mp4  mist.mp4  paper.webp
    audio/       c01.m4a ... c10.m4a  bed.m4a   (plus .ogg copies)
  work/          generated: normalised clips, first and last frames
public/
  frames/<clip>/1440/f_001.webp ...   generated
  frames/<clip>/768/f_001.webp ...    generated
  frames/<clip>/manifest.json         generated
```

`tools/art-video.mjs` also writes `<clip>.last.png` (the real last frame, the next clip's start frame), `<clip>.take<N>.mp4` and `.take<N>.json` while you choose between takes, `<clip>.sheet.png` (a contact sheet) and a `<clip>.json` sidecar next to the clips. Only `<clip>.mp4` is an input to the import; it ignores the rest.

```bash
# 1. Normalise a clip: 24 fps, 1920x1080, near-lossless, no audio
ffmpeg -i art/source/clips/c01-follow.mp4 \
  -vf "fps=24,scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080" \
  -c:v libx264 -crf 12 -preset slow -an art/work/c01-follow.mp4

# 2. N evenly spaced frames per tier (N from the table below), first and last frame included
N=60
D=$(ffprobe -v error -show_entries format=duration -of csv=p=0 art/work/c01-follow.mp4)
FPS=$(awk -v n=$N -v d=$D 'BEGIN { print (n - 1) / d }')
mkdir -p public/frames/c01-follow/1440 public/frames/c01-follow/768
ffmpeg -i art/work/c01-follow.mp4 -vf "fps=$FPS,scale=1440:-2" -frames:v $N \
  -c:v libwebp -quality 78 public/frames/c01-follow/1440/f_%03d.webp
ffmpeg -i art/work/c01-follow.mp4 -vf "fps=$FPS,scale=768:-2" -frames:v $N \
  -c:v libwebp -quality 72 public/frames/c01-follow/768/f_%03d.webp

# 3. First and last frame of the clip (the last one is the next clip's start frame)
ffmpeg -i art/work/c01-follow.mp4 -frames:v 1 art/work/c01-follow.first.png
ffmpeg -sseof -1 -i art/work/c01-follow.mp4 -update 1 art/work/c01-follow.last.png
```

**Frame budget.** Sizes assume about 90 KB a frame at 1440 px wide, quality 78, and about 35 KB at 768 px, quality 72. Real files vary with grain, so the import script measures them and trims to a budget of 60 MB and 22 MB. Only the current chapter and the next two are loaded at once.

| Clip | Frames | 1440 tier (MB) | 768 tier (MB) |
| --- | --- | --- | --- |
| c01-follow | 60 | 5.4 | 2.1 |
| c02-eye | 42 | 3.8 | 1.5 |
| c03-portal | 48 | 4.3 | 1.7 |
| c04-descent | 78 | 7.0 | 2.7 |
| c05-enter | 60 | 5.4 | 2.1 |
| c06-book | 48 | 4.3 | 1.7 |
| c07-pages | 66 | 5.9 | 2.3 |
| c08-sea-alive | 60 | 5.4 | 2.1 |
| c09-shore | 60 | 5.4 | 2.1 |
| c10-sky | 48 | 4.3 | 1.7 |
| Total | 570 | 51 | 20 |

Without c03 the totals fall to 522 frames, 47 MB and 18 MB. Sound adds about 6 MB (AAC at 128 kbps), loaded only when the visitor turns sound on.
