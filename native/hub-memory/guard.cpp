#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cwchar>
#include <limits>
#include <string>
#include <vector>

class Handle {
 public:
  explicit Handle(HANDLE value = nullptr) : value_(value) {}
  ~Handle() { if (value_) CloseHandle(value_); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  HANDLE get() const { return value_; }
 private:
  HANDLE value_;
};

static std::wstring environment(const wchar_t* name) {
  const DWORD size = GetEnvironmentVariableW(name, nullptr, 0);
  if (!size) return {};
  std::vector<wchar_t> buffer(size);
  if (!GetEnvironmentVariableW(name, buffer.data(), size)) return {};
  return buffer.data();
}

static int failure(const char* operation, DWORD code = GetLastError()) {
  std::fprintf(stderr, "t3-hub-guard: %s failed (Windows error %lu)\n", operation, code);
  return 1;
}

int wmain(int argc, wchar_t** argv) {
  if (argc == 2 && std::wcscmp(argv[1], L"--version") == 0) {
    std::puts("t3-hub-guard 1");
    return 0;
  }
  const auto command = environment(L"T3_HUB_GUARDED_COMMAND");
  const auto cap = environment(L"T3_HUB_MEMORY_HARD_CAP_MB");
  wchar_t* end = nullptr;
  errno = 0;
  const auto megabytes = std::wcstoull(cap.c_str(), &end, 10);
  if (command.empty() || cap.empty() || errno || *end ||
      megabytes < 64 || megabytes > 1048576 ||
      megabytes > std::numeric_limits<SIZE_T>::max() / (1024 * 1024)) {
    std::fputs("t3-hub-guard: valid command and commit limit (64..1048576 MiB) required\n", stderr);
    return 1;
  }
  Handle job(CreateJobObjectW(nullptr, nullptr));
  if (!job.get()) return failure("CreateJobObjectW");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
  limits.ProcessMemoryLimit = static_cast<SIZE_T>(megabytes) * 1024 * 1024;
  if (!SetInformationJobObject(job.get(), JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
    return failure("SetInformationJobObject");

  auto shell = environment(L"ComSpec");
  if (shell.empty()) {
    wchar_t directory[MAX_PATH + 1]{};
    if (!GetSystemDirectoryW(directory, MAX_PATH)) return failure("GetSystemDirectoryW");
    shell = std::wstring(directory) + L"\\cmd.exe";
  }
  auto arguments = L"\"" + shell + L"\" /d /s /c \"" + command + L"\"";
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  PROCESS_INFORMATION process{};
  // The child cannot execute or create descendants before its budget is installed.
  if (!CreateProcessW(shell.c_str(), arguments.data(), nullptr, nullptr, TRUE,
      CREATE_SUSPENDED, nullptr, nullptr, &startup, &process)) return failure("CreateProcessW");
  Handle child(process.hProcess);
  Handle thread(process.hThread);
  if (!AssignProcessToJobObject(job.get(), child.get())) {
    const DWORD error = GetLastError();
    TerminateProcess(child.get(), 1);
    WaitForSingleObject(child.get(), INFINITE);
    return failure("AssignProcessToJobObject", error);
  }
  if (ResumeThread(thread.get()) == static_cast<DWORD>(-1)) return failure("ResumeThread");
  if (WaitForSingleObject(child.get(), INFINITE) != WAIT_OBJECT_0) return failure("WaitForSingleObject");
  DWORD code = 1;
  if (!GetExitCodeProcess(child.get(), &code)) return failure("GetExitCodeProcess");
  return static_cast<int>(code);
}
