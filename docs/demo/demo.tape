# Records docs/media/demo.{gif,mp4}:  vhs docs/demo/demo.tape   (run from the repo root)
# npm/gh are shims from docs/demo/bin — registry propagation, a failing suite and a CI run stuck in the queue.
Output docs/media/demo.gif
Output docs/media/demo.mp4

Set Shell bash
Set FontFamily "JetBrainsMono Nerd Font"
Set FontSize 14
Set Width 1300
Set Height 900
Set Padding 16
Set Theme "Catppuccin Mocha"
Set TypingSpeed 12ms

Hide
Type "export PATH=$PWD/docs/demo/bin:$PATH && docs/demo/reset.sh && clear" Enter
Type "pi --no-session -nc -ns -e ./src/index.ts --model claude-subscription/claude-haiku-5-5" Enter
Sleep 5s
Show

Type "I just published @acme/sdk@0.2.0. Without blocking me, wait for: the npm registry to show 0.2.0 (check every 3s), `npm test`, and GitHub CI run 4242 (check every 3s, give it at most 20s). One short line per result."
Sleep 500ms
Enter
Sleep 45s
