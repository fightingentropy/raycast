#!/usr/bin/osascript
# @raycast.schemaVersion 1
# @raycast.title Empty Bin
# @raycast.mode silent
# @raycast.packageName System Utilities
# @raycast.icon 🗑️

tell application "Finder"
    if (count of items in trash) > 0 then
        empty trash
    end if
    quit
end tell
