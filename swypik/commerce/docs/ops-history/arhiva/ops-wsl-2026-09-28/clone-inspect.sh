cd /opt/swypik/app
G="git -c safe.directory=/opt/swypik/app"
echo "modified: $($G status --porcelain --untracked-files=no | wc -l)"
echo "real content diffs (ignoring CR at EOL): $($G -c core.autocrlf=false diff --ignore-cr-at-eol --stat | tail -1)"
$G -c core.autocrlf=false diff --ignore-cr-at-eol --name-only | head -20
echo "--- vs origin/main (content): files where working tree != origin/main ignoring CR:"
$G fetch -q origin; $G -c core.autocrlf=false diff --ignore-cr-at-eol --stat origin/main | tail -2
echo "--- stash:"; $G stash list; $G stash show --stat stash@{0} 2>/dev/null | tail -2
echo "--- mode-only changes: $($G diff --summary | grep -c 'mode change')"
$G config --get core.filemode; $G config --get core.autocrlf
