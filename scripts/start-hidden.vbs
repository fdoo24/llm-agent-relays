' start-hidden.vbs - Запуск команды без всплывающего окна консоли
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
baseDir = fso.GetParentFolderName(scriptDir)

' Если аргументы переданы - запускаем их скрытно
If WScript.Arguments.Count > 0 Then
    cmd = ""
    For Each arg In WScript.Arguments
        cmd = cmd & """" & arg & """ "
    Next
    WshShell.Run cmd, 0, False
Else
    ' По умолчанию запускаем manage.ps1 start
    psCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & scriptDir & "\manage.ps1"" -Action start"
    WshShell.Run psCmd, 0, False
End If
