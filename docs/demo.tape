Output docs/assets/sks-v5-demo.gif
Set Shell "zsh"
Set FontSize 16
Set Width 1280
Set Height 720
Set TypingSpeed 20ms

Type "npm exec --yes --package=sneakoscope@latest -- sneakoscope install --yes"
Sleep 500ms
Enter
Sleep 1s
Ctrl+C

Type "sks plan \"ship a proof-first review flow\""
Enter
Sleep 1s

Type "sks review --staged"
Enter
Sleep 1s

Type "sks status --json"
Enter
Sleep 1s

Type "sks naruto run \"demo official subagent workflow\" --agents 4 --max-threads 4 --json"
Enter
Sleep 2s
