' Creates one hidden process through WMI. The WMI host service creates it, so it is not a member
' of any job object that encloses the caller and survives that job being closed.
' This file is constant: the command line, working directory and start environment arrive in the
' environment of this script's own process. Nothing secret may be placed in them.
Option Explicit
Dim environment, wmi, startup, variables, processId, result
Set environment = CreateObject("WScript.Shell").Environment("PROCESS")
Set wmi = GetObject("winmgmts:{impersonationLevel=impersonate}!\\.\root\cimv2")
Set startup = wmi.Get("Win32_ProcessStartup").SpawnInstance_
' Mandatory: without it the new process may show a console window and take focus.
startup.ShowWindow = 0
' When set, this list is the whole environment of the new process, not an addition to a default.
variables = environment("T3_WD_ENVIRONMENT")
If Len(variables) > 0 Then startup.EnvironmentVariables = Split(variables, vbLf)
result = wmi.Get("Win32_Process").Create(environment("T3_WD_COMMAND"), environment("T3_WD_CWD"), startup, processId)
If result <> 0 Then WScript.Quit 1
' An unhandled script error can still exit 0, so the caller requires this line as well.
WScript.StdOut.WriteLine "t3-watchdog-created " & processId
WScript.Quit 0
