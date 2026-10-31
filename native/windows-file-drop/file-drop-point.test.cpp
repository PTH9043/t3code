#include "file-drop.cpp"
#include <cassert>

int main() {
  const RECT client = {0, 0, 1674, 1387};
  const POINT actual = {766, 1184};
  // The production failure had a negative client X although the file was dropped
  // over the visible app. The position on the queued message owns hit testing.
  auto point = ResolveDropPoint({-119, 1184}, actual, client, true);
  assert(point.x == 766 && point.y == 1184);
  // A plausible but stale point must not select the wrong sidebar project.
  point = ResolveDropPoint({38, 941}, actual, client, true);
  assert(point.x == 766 && point.y == 1184);
  // A hidden window or a drop message whose cursor belongs elsewhere uses the
  // supplied drop point; it cannot borrow another app's current mouse position.
  point = ResolveDropPoint({675, 636}, {20, 100}, client, false);
  assert(point.x == 675 && point.y == 636);
  point = ResolveDropPoint({675, 636}, {-1, 200}, client, true);
  assert(point.x == 675 && point.y == 636);
  point = ResolveDropPoint({675, 636}, {1674, 200}, client, true);
  assert(point.x == 675 && point.y == 636);
  point = ResolveDropPoint({675, 636}, {500, 1387}, client, true);
  assert(point.x == 675 && point.y == 636);
  const auto leftMonitor = MessagePoint(static_cast<DWORD>(MAKELONG(static_cast<WORD>(-1891), 133)));
  assert(leftMonitor.x == -1891 && leftMonitor.y == 133);
  const auto upperMonitor = MessagePoint(static_cast<DWORD>(MAKELONG(400, static_cast<WORD>(-800))));
  assert(upperMonitor.x == 400 && upperMonitor.y == -800);
  return 0;
}
