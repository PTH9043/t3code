
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class T3JobGuard {
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public Int64 PerProcessUserTimeLimit; public Int64 PerJobUserTimeLimit; public UInt32 LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public UInt32 ActiveProcessLimit;
    public UIntPtr Affinity; public UInt32 PriorityClass; public UInt32 SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS {
    public UInt64 ReadOperationCount; public UInt64 WriteOperationCount; public UInt64 OtherOperationCount;
    public UInt64 ReadTransferCount; public UInt64 WriteTransferCount; public UInt64 OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public uint cb; public string reserved; public string desktop; public string title;
    public uint x, y, xSize, ySize, xCountChars, yCountChars, fillAttribute, flags;
    public ushort showWindow, reservedSize; public IntPtr reservedData;
    public IntPtr stdInput, stdOutput, stdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr process, thread; public uint processId, threadId;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessW(string application, StringBuilder commandLine,
    IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags,
    IntPtr environment, string cwd, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetStdHandle(int handle);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);
  static Exception Failure(string operation) {
    return new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed");
  }
  public static IntPtr Create(ulong commitLimitBytes) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Exception("CreateJobObject failed: " + Marshal.GetLastWin32Error());
    var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    info.BasicLimitInformation.LimitFlags = 0x2000 | 0x100; // KILL_ON_JOB_CLOSE | PROCESS_MEMORY
    info.ProcessMemoryLimit = (UIntPtr)commitLimitBytes;
    if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(info))) {
      var error = Failure("SetInformationJobObject");
      CloseHandle(job);
      throw error;
    }
    return job;
  }
  public static int Run(string shell, string command, string cwd, ulong capBytes) {
    IntPtr job = Create(capBytes);
    var process = new PROCESS_INFORMATION();
    try {
      var startup = new STARTUPINFO();
      startup.cb = (uint)Marshal.SizeOf(startup);
      startup.flags = 0x100; // STARTF_USESTDHANDLES: retain the PTY / redirected streams.
      startup.stdInput = GetStdHandle(-10);
      startup.stdOutput = GetStdHandle(-11);
      startup.stdError = GetStdHandle(-12);
      var arguments = new StringBuilder("\"" + shell + "\" /d /s /c \"" + command + "\"");
      // CREATE_SUSPENDED prevents the command and its descendants from running before assignment.
      if (!CreateProcessW(shell, arguments, IntPtr.Zero, IntPtr.Zero, true, 0x4,
          IntPtr.Zero, cwd, ref startup, out process)) throw Failure("CreateProcessW");
      if (!AssignProcessToJobObject(job, process.process)) throw Failure("AssignProcessToJobObject");
      if (ResumeThread(process.thread) == uint.MaxValue) throw Failure("ResumeThread");
      if (WaitForSingleObject(process.process, uint.MaxValue) != 0) throw Failure("WaitForSingleObject");
      uint code;
      if (!GetExitCodeProcess(process.process, out code)) throw Failure("GetExitCodeProcess");
      return unchecked((int)code);
    } catch {
      // Assignment may have failed, so closing the job alone cannot clean up this suspended child.
      if (process.process != IntPtr.Zero) TerminateProcess(process.process, 1);
      throw;
    } finally {
      if (process.thread != IntPtr.Zero) CloseHandle(process.thread);
      if (process.process != IntPtr.Zero) CloseHandle(process.process);
      CloseHandle(job);
    }
  }
}
'@
$command = $env:T3_HUB_GUARDED_COMMAND
$capMb = [uint64]$env:T3_HUB_MEMORY_HARD_CAP_MB
if (-not $command) { throw 'T3_HUB_GUARDED_COMMAND is empty' }
$shell = $env:ComSpec
if (-not $shell) { $shell = Join-Path $env:SystemRoot 'System32\cmd.exe' }
exit [T3JobGuard]::Run($shell, $command, (Get-Location).Path, ($capMb * 1MB))
