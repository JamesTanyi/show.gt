Dim fso, wsh, dir
Set fso = CreateObject("Scripting.FileSystemObject")
Set wsh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
wsh.CurrentDirectory = dir
wsh.Run """" & dir & "\node_modules\electron\dist\electron.exe"" .", 1, False
