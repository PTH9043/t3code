Option Explicit
Dim fs, sh, base, launcher, pythonw, ws, shortcut
Set fs = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = fs.GetParentFolderName(WScript.ScriptFullName)
launcher = fs.BuildPath(base, "upgrade-room-runtime.py")
' Installer replaces this one literal with the absolute sibling of sys.executable.
pythonw = "__INSTALLED_PYTHONW__"
ws = fs.BuildPath(sh.ExpandEnvironmentStrings("%SystemRoot%"), "System32\wscript.exe")
If WScript.Arguments.Count = 0 Then
  WScript.Quit sh.Run(Q(pythonw) & " -I -B " & Q(launcher) & " open", 0, True)
End If
If WScript.Arguments.Count <> 1 Then WScript.Quit 2
If WScript.Arguments(0) = "start-host" Then
  ' WMI owns this local child. A recursive stop of the desktop and this
  ' request can safely happen even before the room has published its PID.
  Dim service, startup, brokerPid, rc
  Set service = GetObject("winmgmts:{impersonationLevel=impersonate}!\\.\root\cimv2")
  Set startup = service.Get("Win32_ProcessStartup").SpawnInstance_
  startup.ShowWindow = 0
  ' Preserve the calling user's profile and CLI search path across the WMI service boundary.
  Dim callerEnv, values(), count, key
  Set callerEnv = sh.Environment("Process")
  count = 0
  For Each key In Array("SystemRoot", "SystemDrive", "ComSpec", "USERPROFILE", "USERNAME", "USERDOMAIN", _
      "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "ProgramFiles", "ProgramFiles(x86)", _
      "ProgramData", "PATH", "PATHEXT", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS")
    If Len(callerEnv(key)) > 0 Then
      ReDim Preserve values(count)
      values(count) = key & "=" & callerEnv(key)
      count = count + 1
    End If
  Next
  startup.EnvironmentVariables = values
  rc = service.Get("Win32_Process").Create(Q(pythonw) & " -I -B " & Q(launcher) & " _start-host", base, startup, brokerPid)
  If rc <> 0 Then WScript.Quit 1
  WScript.StdOut.WriteLine CStr(brokerPid)
  WScript.Quit 0
End If
If WScript.Arguments(0) <> "install-shortcut" Then WScript.Quit 2
Set shortcut = sh.CreateShortcut(fs.BuildPath(sh.SpecialFolders("Desktop"), "AutoUsage Upgrade Room.lnk"))
shortcut.TargetPath = ws
shortcut.Arguments = Q(WScript.ScriptFullName)
shortcut.WorkingDirectory = base
shortcut.Description = "AutoUsage upgrade room"
shortcut.Save
Function Q(s)
  Q = Chr(34) & s & Chr(34)
End Function
