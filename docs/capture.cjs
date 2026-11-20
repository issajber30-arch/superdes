// README media capture: records docs/demo (webm -> convert with ffmpeg) and the docs/screens stills from a running
// non-preview copy of the app at http://localhost:5181 (API on :8021) with a fresh demo studio. Test data only.
// Usage: PW=<path to node_modules/playwright> OUT=<empty dir> node docs/capture.cjs
// Then:  ffmpeg -i $OUT/demo.webm -vf "scale=1100:600,fps=12" -c:v libx264 -crf 28 -pix_fmt yuv420p -an docs/demo/superdes-demo.mp4
//        ffmpeg -i $OUT/demo.webm -vf "fps=5,scale=900:-1,split[a][b];[a]palettegen=max_colors=48:stats_mode=diff[p];[b][p]paletteuse=dither=none" docs/demo/superdes-demo.gif
