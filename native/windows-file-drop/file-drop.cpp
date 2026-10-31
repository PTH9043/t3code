#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <commctrl.h>
#include <new>
#include <vector>

namespace {
constexpr wchar_t kStateProperty[] = L"T3.FileDrop.Receiver";
constexpr UINT_PTR kSubclassId = 0x54334452;
constexpr UINT kRefresh = WM_APP + 0x2A4;
constexpr UINT kCopyGlobalData = 0x49;
struct Receiver {
  HWND root;
  UINT notify;
  bool enabled;
  std::vector<HWND> children;
  std::vector<HDROP> pending;
};

bool OwnThreadWindow(HWND window) {
  DWORD pid = 0;
  return GetWindowThreadProcessId(window, &pid) == GetCurrentThreadId() &&
         pid == GetCurrentProcessId();
}

bool AllowFiles(HWND window) {
  if (!ChangeWindowMessageFilterEx(window, WM_DROPFILES, MSGFLT_ALLOW, nullptr) ||
      !ChangeWindowMessageFilterEx(window, kCopyGlobalData, MSGFLT_ALLOW, nullptr)) {
    return false;
  }
  DragAcceptFiles(window, TRUE);
  return true;
}

POINT MessagePoint(DWORD position) {
  // Virtual desktops can have negative screen coordinates.
  return {static_cast<SHORT>(LOWORD(position)), static_cast<SHORT>(HIWORD(position))};
}

POINT ResolveDropPoint(POINT supplied, POINT message, RECT client, bool targetsRoot) {
  return targetsRoot && PtInRect(&client, message) ? message : supplied;
}

LRESULT CALLBACK Receive(HWND, UINT, WPARAM, LPARAM, UINT_PTR, DWORD_PTR);

BOOL CALLBACK AttachChild(HWND child, LPARAM data) {
  auto* receiver = reinterpret_cast<Receiver*>(data);
  wchar_t name[128] = {};
  if (!OwnThreadWindow(child) ||
      !GetClassNameW(child, name, static_cast<int>(sizeof(name) / sizeof(name[0]))) ||
      lstrcmpW(name, L"Chrome_RenderWidgetHostHWND") != 0) {
    return TRUE;
  }
  DWORD_PTR prior = 0;
  if (GetWindowSubclass(child, Receive, kSubclassId, &prior)) return TRUE;
  if (SetWindowSubclass(child, Receive, kSubclassId,
                        reinterpret_cast<DWORD_PTR>(receiver))) {
    if (AllowFiles(child)) {
      DragAcceptFiles(child, receiver->enabled ? TRUE : FALSE);
      receiver->children.push_back(child);
    }
    else RemoveWindowSubclass(child, Receive, kSubclassId);
  }
  return TRUE;
}

void Refresh(Receiver* receiver) {
  EnumChildWindows(receiver->root, AttachChild, reinterpret_cast<LPARAM>(receiver));
}

void Clear(Receiver* receiver) {
  RemovePropW(receiver->root, kStateProperty);
  for (HWND child : receiver->children) {
    if (IsWindow(child)) {
      RemoveWindowSubclass(child, Receive, kSubclassId);
      DragAcceptFiles(child, FALSE);
    }
  }
  RemoveWindowSubclass(receiver->root, Receive, kSubclassId);
  for (HDROP drop : receiver->pending) DragFinish(drop);
  delete receiver;
}

LRESULT CALLBACK Receive(HWND window, UINT message, WPARAM wParam, LPARAM lParam,
                         UINT_PTR, DWORD_PTR data) {
  auto* receiver = reinterpret_cast<Receiver*>(data);
  if (message == WM_DROPFILES) {
    auto drop = reinterpret_cast<HDROP>(wParam);
    if (!receiver->enabled) { DragFinish(drop); return 0; }
    auto* header = static_cast<DROPFILES*>(GlobalLock(drop));
    if (header == nullptr || GlobalSize(drop) < sizeof(DROPFILES)) {
      if (header != nullptr) GlobalUnlock(drop);
      DragFinish(drop);
      return 0;
    }
    POINT point = header->pt;
    if (header->fNC) ScreenToClient(receiver->root, &point);
    else if (window != receiver->root) MapWindowPoints(window, receiver->root, &point, 1);
    // Read the queued drop message's position before posting our asynchronous
    // notification. CF_HDROP coordinates supplied by another process can be stale
    // or relative to a different window. Never sample the cursor after file I/O.
    POINT messagePoint = MessagePoint(GetMessagePos());
    const HWND hit = WindowFromPoint(messagePoint);
    const bool targetsRoot = hit == receiver->root || IsChild(receiver->root, hit);
    RECT client = {};
    bool usedMessagePoint = false;
    if (targetsRoot && ScreenToClient(receiver->root, &messagePoint) &&
        GetClientRect(receiver->root, &client)) {
      usedMessagePoint = PtInRect(&client, messagePoint) != FALSE;
      point = ResolveDropPoint(point, messagePoint, client, true);
    }
    header->pt = point;
    header->fNC = FALSE;
    GlobalUnlock(drop);
    // The app owns HDROP only after this succeeds; only its private message
    // reaches Electron. The original WM_DROPFILES is consumed exactly once.
    if (PostMessageW(receiver->root, receiver->notify, wParam, usedMessagePoint ? 1 : 0)) receiver->pending.push_back(drop);
    else DragFinish(drop);
    return 0;
  }
  if (window == receiver->root && message == receiver->notify) {
    const auto drop = reinterpret_cast<HDROP>(wParam);
    bool owned = false;
    for (auto it = receiver->pending.begin(); it != receiver->pending.end(); ++it) {
      if (*it == drop) { receiver->pending.erase(it); owned = true; break; }
    }
    if (!owned) return 0;
  }
  if (window == receiver->root && message == kRefresh) {
    Refresh(receiver);
    return 0;
  }
  if (window == receiver->root && message == WM_PARENTNOTIFY && LOWORD(wParam) == WM_CREATE) {
    PostMessageW(receiver->root, kRefresh, 0, 0);
  }
  if (message == WM_NCDESTROY) {
    if (window == receiver->root) Clear(receiver);
    else {
      RemoveWindowSubclass(window, Receive, kSubclassId);
      for (auto it = receiver->children.begin(); it != receiver->children.end(); ++it) {
        if (*it == window) { receiver->children.erase(it); break; }
      }
    }
  }
  return DefSubclassProc(window, message, wParam, lParam);
}
}

extern "C" __declspec(dllexport) unsigned int T3InstallFileDrop(HWND window, UINT notify) {
  if (!OwnThreadWindow(window) || notify < WM_APP || notify == kRefresh) return 0;
  auto* prior = static_cast<Receiver*>(GetPropW(window, kStateProperty));
  if (prior != nullptr) { Refresh(prior); return static_cast<unsigned int>(prior->children.size() + 1); }
  auto* receiver = new (std::nothrow) Receiver{window, notify, true, {}, {}};
  if (receiver == nullptr) return 0;
  if (!SetPropW(window, kStateProperty, receiver) ||
      !SetWindowSubclass(window, Receive, kSubclassId, reinterpret_cast<DWORD_PTR>(receiver))) {
    RemovePropW(window, kStateProperty); delete receiver; return 0;
  }
  if (!AllowFiles(window)) { Clear(receiver); return 0; }
  Refresh(receiver);
  return static_cast<unsigned int>(receiver->children.size() + 1);
}

extern "C" __declspec(dllexport) unsigned int T3RefreshFileDrop(HWND window) {
  if (!OwnThreadWindow(window)) return 0;
  auto* receiver = static_cast<Receiver*>(GetPropW(window, kStateProperty));
  if (receiver == nullptr) return 0;
  Refresh(receiver);
  return static_cast<unsigned int>(receiver->children.size() + 1);
}

extern "C" __declspec(dllexport) void T3UninstallFileDrop(HWND window) {
  if (!OwnThreadWindow(window)) return;
  auto* receiver = static_cast<Receiver*>(GetPropW(window, kStateProperty));
  if (receiver != nullptr) Clear(receiver);
}

extern "C" __declspec(dllexport) void T3EnableFileDrop(HWND window, BOOL enabled) {
  if (!OwnThreadWindow(window)) return;
  auto* receiver = static_cast<Receiver*>(GetPropW(window, kStateProperty));
  if (receiver == nullptr) return;
  receiver->enabled = enabled != FALSE;
  DragAcceptFiles(window, enabled);
  for (HWND child : receiver->children) if (IsWindow(child)) DragAcceptFiles(child, enabled);
}
