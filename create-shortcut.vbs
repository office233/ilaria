Set oWS = WScript.CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
sLinkFile = oWS.SpecialFolders("Desktop") & "\SwypikOS.lnk"
Set oLink = oWS.CreateShortcut(sLinkFile)
oLink.TargetPath = fso.BuildPath(baseDir, "bin\swypik-os.exe")
oLink.WorkingDirectory = baseDir
oLink.Description = "SwypikOS Native Operating System"
oLink.Save
