' Starts the AI Monitor local service without a console window (used by the logon task).
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = fso.GetParentFolderName(dir)
shell.Run "node """ & dir & "\server.js""", 0, False
