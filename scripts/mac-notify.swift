import Foundation
import AppKit

// DD-claw 的 macOS 通知 helper。被编译进 DD-claw.app bundle 以获得正确的
// 通知身份（名字 + 图标），并常驻 runloop 等待点击（点击后打开 --url，
// 或超时退出避免僵尸进程）。
//
// 用法（execFile/spawn 数组传参，不经 shell，无引号转义问题）：
//   DD-claw --title "标题" [--subtitle "小字"] --message "正文" [--url "https://..."] [--image "/本地图路径"]

struct Args {
  var title = "DD-claw"
  var subtitle: String? = nil
  var message = ""
  var url: String? = nil
  var image: String? = nil
  var timeout: TimeInterval = 600
}

func parseArgs(_ argv: [String]) -> Args {
  var a = Args()
  var i = 1
  func next(_ k: String) -> String? {
    i += 1
    return i < argv.count ? argv[i] : nil
  }
  while i < argv.count {
    switch argv[i] {
    case "--title": if let v = next(argv[i]) { a.title = v }
    case "--subtitle": if let v = next(argv[i]) { a.subtitle = v }
    case "--message": if let v = next(argv[i]) { a.message = v }
    case "--url": if let v = next(argv[i]) { a.url = v }
    case "--image": if let v = next(argv[i]) { a.image = v }
    case "--timeout": if let v = next(argv[i]) { a.timeout = TimeInterval(v) ?? 600 }
    default: break
    }
    i += 1
  }
  return a
}

final class ClickDelegate: NSObject, NSUserNotificationCenterDelegate {
  private let url: String?
  init(url: String?) { self.url = url }

  func userNotificationCenter(_ center: NSUserNotificationCenter, didActivate notification: NSUserNotification) {
    if let u = url, let parsed = URL(string: u) {
      NSWorkspace.shared.open(parsed)
    }
    exit(0)
  }

  func userNotificationCenter(_ center: NSUserNotificationCenter, shouldPresent notification: NSUserNotification) -> Bool {
    true
  }
}

let a = parseArgs(CommandLine.arguments)

let n = NSUserNotification()
n.title = a.title
n.subtitle = a.subtitle
n.informativeText = a.message
if let u = a.url, !u.isEmpty {
  n.userInfo = ["url": u]
  n.actionButtonTitle = "打开"
}
if let img = a.image, !img.isEmpty, let image = NSImage(contentsOfFile: img) {
  n.contentImage = image
}

let delegate = ClickDelegate(url: a.url)
NSUserNotificationCenter.default.delegate = delegate
NSUserNotificationCenter.default.deliver(n)

// 等待点击；超时退出（通知被忽略时不残留进程）。
DispatchQueue.main.asyncAfter(deadline: .now() + a.timeout) { exit(0) }
RunLoop.main.run()
