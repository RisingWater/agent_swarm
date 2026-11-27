"""Agent Swarm 桌面安装管理器。"""

import os
import sys
from pathlib import Path

# 源码版也可直接由桌面入口启动。
if not __package__:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PySide6.QtCore import QLockFile, Qt, QThread, QTimer, QStandardPaths, Signal
from PySide6.QtGui import QColor, QFontDatabase, QIcon
from PySide6.QtWidgets import (
    QApplication, QCheckBox, QDialog, QDialogButtonBox, QFormLayout, QFrame, QHBoxLayout,
    QHeaderView, QLabel, QLineEdit, QMainWindow, QMenu, QMessageBox, QProgressBar, QPushButton,
    QStackedLayout, QTableWidget, QTableWidgetItem, QSystemTrayIcon, QVBoxLayout, QWidget,
)

from desktop.core import PluginManager
from desktop.local import AGENTS, LocalPlugins, get_autostart, set_autostart
from desktop.setup import install_manager, installed_executable


STYLE = """
QWidget { background: #fdfcfc; color: #201d1d; font-size: 14px; }
QLabel#muted { color: #666262; font-size: 13px; }
QFrame#card { border: 1px solid #e2dfdf; border-radius: 6px; }
QPushButton { padding: 6px 13px; border: 1px solid #e2dfdf; border-radius: 4px; background: #fdfcfc; font-weight: 500; }
QPushButton:hover { background: #f8f7f7; }
QPushButton:focus { border-color: #777272; }
QPushButton#primary { background: #201d1d; color: #fdfcfc; border-color: #201d1d; }
QPushButton#primary:hover { background: #302c2c; }
QPushButton#primary:focus { border-color: #807979; }
QPushButton#danger { color: #d4494b; }
QPushButton#danger:hover { background: #fdf1f1; border-color: #d4494b; }
QPushButton:disabled, QPushButton#primary:disabled, QPushButton#danger:disabled {
    background: #f5f3f3; color: #827d7d; border-color: #e9e6e6;
}
QTableWidget { background: #fdfcfc; border: none; outline: none; gridline-color: #e9e6e6; }
QTableWidget::item { padding: 6px 10px; border-bottom: 1px solid #e9e6e6; }
QHeaderView::section { padding: 9px 10px; background: #f8f7f7; color: #666262; border: none;
    border-bottom: 1px solid #e2dfdf; font-size: 13px; font-weight: 500; }
QWidget#rowAction { background: transparent; }
QWidget#rowAction QPushButton { padding: 4px 10px; }
QLineEdit { background: #fdfcfc; border: 1px solid #e2dfdf; border-radius: 4px; padding: 8px 12px; }
QLineEdit:focus { border-color: #201d1d; }
QProgressBar { border: 0; height: 3px; background: #e9e6e6; }
QProgressBar::chunk { background: #201d1d; }
QFrame#operationMask { background: rgba(32, 29, 29, 100); }
QFrame#operationPanel { background: #fdfcfc; border: 1px solid #e2dfdf; border-radius: 6px; }
QFrame#operationPanel QLabel { background: transparent; }
QFrame#operationPanel QProgressBar { border-radius: 2px; }
QFrame#operationPanel QProgressBar::chunk { border-radius: 2px; }
"""


def icon() -> QIcon:
    resources = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
    return QIcon(str(resources / "desktop/assets/manager.svg"))


class Operation(QThread):
    progress = Signal(str)

    def __init__(self, manager, action, args):
        super().__init__()
        self.manager, self.action, self.args = manager, action, args
        self.data = None
        self.results = {}
        self.error = ""

    def run(self):
        try:
            if self.action == "check":
                self.data = self.manager.check()
                return
            if self.action == "login":
                self.results = self.manager.login(*self.args, self.progress.emit)
            elif self.action == "install":
                self.results = self.manager.install(*self.args, self.progress.emit)
            elif self.action == "logout":
                self.results = self.manager.logout(self.progress.emit)
                self.data = self.manager.snapshot()
                return
            elif self.action == "restart":
                for name in self.args[0]:
                    self.progress.emit(f"正在请求 {AGENTS[name].label} 关闭并重启…")
                    self.results[name] = (True, self.manager.local.restart_desktop(name))
                self.data = self.manager.snapshot()
                return
            self.data = self.manager.check()
        except Exception as exc:
            self.error = str(exc)
            if self.manager.account:
                self.error = self.error.replace(self.manager.account.api_key, "••••")
        finally:
            # 清掉本次登录输入中的密码。
            self.args = ()
            if self.data is None:
                try:
                    self.data = self.manager.snapshot()
                except Exception:
                    pass


class LoginDialog(QDialog):
    def __init__(self, previous, switching, parent):
        super().__init__(parent)
        self.setMinimumWidth(430)
        self.setWindowTitle("切换账号或服务器" if switching else "登录 Agent Swarm")
        layout = QVBoxLayout(self)
        if switching:
            note = QLabel("换账号或服务器后，现有 Swarm 插件会使用新账号重新安装。")
            note.setWordWrap(True)
            layout.addWidget(note)
        form = QFormLayout()
        self.server = QLineEdit(previous.get("server", ""))
        self.server.setPlaceholderText("https://swarm.example.com 或 http://10.0.0.1:8700")
        self.name = QLineEdit(previous.get("name", ""))
        self.password = QLineEdit()
        self.password.setEchoMode(QLineEdit.EchoMode.Password)
        form.addRow("服务器地址", self.server)
        form.addRow("用户名", self.name)
        form.addRow("密码", self.password)
        layout.addLayout(form)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel)
        login = buttons.button(QDialogButtonBox.StandardButton.Ok)
        login.setText("登录")
        login.setObjectName("primary")
        buttons.button(QDialogButtonBox.StandardButton.Cancel).setText("取消")
        buttons.accepted.connect(self.validate)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)
        (self.password if self.name.text() else self.server).setFocus()

    def validate(self):
        if not (self.server.text().strip() and self.name.text().strip() and self.password.text()):
            QMessageBox.information(self, "登录", "请填写服务器地址、用户名和密码。")
            return
        self.accept()

    def credentials(self):
        return self.server.text(), self.name.text().strip(), self.password.text()


class Window(QMainWindow):
    def __init__(self, manager: PluginManager, app_icon: QIcon):
        super().__init__()
        self.manager = manager
        self.job: Operation | None = None
        self.pending_restart = set()
        self.snapshot = {"account": None, "rows": {}}
        self.notified = None
        self.force_close = False
        self.setWindowTitle("Agent Swarm")
        self.setWindowIcon(app_icon)
        self.resize(820, 392)
        self.setMinimumSize(720, 382)

        layers = QWidget()
        stack = QStackedLayout(layers)
        stack.setStackingMode(QStackedLayout.StackingMode.StackAll)
        self.body = QWidget()
        stack.addWidget(self.body)
        self.setCentralWidget(layers)
        layout = QVBoxLayout(self.body)
        layout.setContentsMargins(22, 18, 22, 14)
        layout.setSpacing(12)

        account_bar = QFrame(objectName="card")
        top = QHBoxLayout(account_bar)
        top.setContentsMargins(14, 8, 14, 8)
        self.account_label = QLabel("未登录")
        self.account_label.setTextFormat(Qt.TextFormat.PlainText)
        self.login_button = self.button("登录", self.login, primary=True)
        self.logout_button = self.button("退出登录并卸载", self.logout)
        self.logout_button.setObjectName("danger")
        top.addWidget(self.account_label, 1)
        top.addWidget(self.login_button)
        top.addWidget(self.logout_button)
        layout.addWidget(account_bar)

        table_card = QFrame(objectName="card")
        card_layout = QVBoxLayout(table_card)
        card_layout.setContentsMargins(1, 1, 1, 2)
        self.table = QTableWidget(len(AGENTS), 5)
        self.table.setHorizontalHeaderLabels(("客户端", "客户端版本", "已安装插件", "服务器版本", "操作"))
        self.table.verticalHeader().hide()
        self.table.verticalHeader().setDefaultSectionSize(44)
        header = self.table.horizontalHeader()
        header.setFixedHeight(38)
        header.setDefaultAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter)
        header.setSectionResizeMode(QHeaderView.ResizeMode.Fixed)
        header.setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        for column, width in enumerate((131, 151, 135, 90), start=1):
            self.table.setColumnWidth(column, width)
        self.table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.table.setSelectionMode(QTableWidget.SelectionMode.NoSelection)
        self.table.setShowGrid(False)
        self.table.setWordWrap(False)
        self.table.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.table.setMinimumHeight(header.height() + self.table.verticalHeader().length() + 2 * self.table.frameWidth())
        card_layout.addWidget(self.table)
        layout.addWidget(table_card, 1)

        actions = QHBoxLayout()
        self.autostart = QCheckBox("开机启动")
        self.autostart.setVisible(sys.platform in ("win32", "linux"))
        try:
            self.autostart.setChecked(get_autostart())
        except OSError:
            pass
        self.autostart.toggled.connect(self.toggle_startup)
        self.check_button = self.button("检查更新", lambda: self.start("check"))
        self.restart_button = self.button("重启客户端", self.restart)
        self.install_button = self.button("全部安装", lambda: self.batch("new"))
        self.update_button = self.button("全部更新", lambda: self.batch("update"), primary=True)
        actions.addWidget(self.autostart)
        actions.addStretch()
        for button in (self.restart_button, self.check_button, self.install_button, self.update_button):
            actions.addWidget(button)
        layout.addLayout(actions)

        self.status = QLabel("正在检测本机客户端…")
        self.status.setObjectName("muted")
        self.status.setTextFormat(Qt.TextFormat.PlainText)
        layout.addWidget(self.status)

        self.operation_mask = QFrame(objectName="operationMask")
        mask_layout = QVBoxLayout(self.operation_mask)
        panel = QFrame(objectName="operationPanel")
        panel.setFixedWidth(304)
        panel_layout = QVBoxLayout(panel)
        panel_layout.setContentsMargins(20, 18, 20, 18)
        panel_layout.setSpacing(12)
        self.operation_status = QLabel()
        self.operation_status.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.operation_status.setTextFormat(Qt.TextFormat.PlainText)
        self.operation_status.setWordWrap(True)
        panel_layout.addWidget(self.operation_status)
        progress = QProgressBar()
        progress.setRange(0, 0)
        progress.setFixedHeight(5)
        progress.setTextVisible(False)
        panel_layout.addWidget(progress)
        mask_layout.addStretch()
        mask_layout.addWidget(panel, alignment=Qt.AlignmentFlag.AlignHCenter)
        mask_layout.addStretch()
        stack.addWidget(self.operation_mask)
        self.operation_mask.hide()

        self.tray = QSystemTrayIcon(app_icon, self)
        self.tray.setToolTip("Agent Swarm 插件管理器")
        self.menu = QMenu()
        self.menu.addAction("打开插件管理器", self.reveal)
        self.menu.addAction("检查更新", lambda: self.start("check"))
        self.menu.addSeparator()
        self.menu.addAction("退出程序", self.quit)
        self.tray.setContextMenu(self.menu)
        self.tray.activated.connect(self.tray_activated)
        if QSystemTrayIcon.isSystemTrayAvailable():
            self.tray.show()
        self.timer = QTimer(self)
        self.timer.setInterval(15 * 60 * 1000)
        self.timer.timeout.connect(self.auto_check)
        self.timer.start()
        QTimer.singleShot(0, lambda: self.start("check"))

    @staticmethod
    def button(label, callback, primary=False):
        button = QPushButton(label, objectName="primary" if primary else "")
        button.clicked.connect(callback)
        return button

    def start(self, action, *args):
        if self.job is not None:
            return
        self.job = Operation(self.manager, action, args)
        self.job.progress.connect(self.report_progress)
        self.job.finished.connect(self.done)
        self.operation_status.setText({"check": "正在检查客户端和插件版本…", "install": "正在下载插件…",
                                       "logout": "正在卸载插件…", "login": "正在登录…",
                                       "restart": "正在重启客户端…"}[action])
        self.body.setEnabled(False)
        self.operation_mask.show()
        self.operation_mask.raise_()
        self.render()
        self.job.start()

    def report_progress(self, message):
        self.operation_status.setText(message)

    def done(self):
        job, self.job = self.job, None
        self.operation_mask.hide()
        self.body.setEnabled(True)
        if job.data is not None:
            self.snapshot = job.data
        for name, (ok, message) in job.results.items():
            if ok and job.action in ("install", "login", "logout") and "仍在运行" in message:
                self.pending_restart.add(name)
            elif ok and message == "桌面客户端已重启":
                self.pending_restart.discard(name)
        self.render()
        self.status.setText("可以安装或更新插件。" if self.snapshot["account"] else "登录后可安装或更新插件。")
        details = [f"{AGENTS[name].label} · {message}" for name, (ok, message) in job.results.items() if not ok]
        if job.error:
            details.append(job.error)
        if details:
            if self.isVisible():
                QMessageBox.warning(self, "操作未全部完成", "\n\n".join(details))
            elif self.tray.isVisible():
                self.tray.showMessage("Agent Swarm", details[-1], QSystemTrayIcon.MessageIcon.Warning)
        job.deleteLater()
        updates = tuple((name, row["latest"]) for name, row in self.snapshot["rows"].items() if row["needs_update"])
        if updates and updates != self.notified and self.tray.isVisible() and job.action == "check":
            self.notified = updates
            self.tray.showMessage("有插件可以更新", "、".join(AGENTS[name].label for name, _ in updates))

    def batch(self, kind):
        names = [name for name, row in self.snapshot["rows"].items() if row["agent"]["path"] and row["latest"]
                 and (not row["installed"] if kind == "new" else row["installed"] and row["needs_update"])]
        if names:
            self.start("install", names)

    def render(self):
        account = self.snapshot["account"]
        idle = self.job is None
        rows = self.snapshot["rows"]
        self.account_label.setText(f'{account["name"]}  ·  {account["server"]}' if account else "未登录")
        self.login_button.setText("切换账号或服务器" if account else "登录")
        self.login_button.setEnabled(idle)
        self.logout_button.setEnabled(idle and (account is not None or any(row["installed"] for row in rows.values())))
        self.check_button.setEnabled(idle)
        self.restart_button.setVisible(sys.platform == "win32" and bool(self.pending_restart))
        self.restart_button.setEnabled(idle)
        self.install_button.setEnabled(idle and bool(account) and any(
            row["agent"]["path"] and row["latest"] and not row["installed"] for row in rows.values()
        ))
        self.update_button.setEnabled(idle and bool(account) and any(
            row["agent"]["path"] and row["latest"] and row["needs_update"] for row in rows.values()
        ))
        for index, (name, agent) in enumerate(AGENTS.items()):
            row = rows.get(name, {})
            found = row.get("agent", {})
            detected = bool(found.get("path"))
            installed = row.get("installed", False)
            latest = row.get("latest")
            version = row.get("version")
            values = [agent.label, found.get("version") or ("版本未知" if detected else "未检测到"),
                      (version[:10] if version else "已安装（未知版本）") if installed else "未安装",
                      latest[:10] if latest else "—"]
            for column, text in enumerate(values):
                cell = QTableWidgetItem(text)
                if column == 0:
                    font = self.table.font()
                    font.setBold(True)
                    cell.setFont(font)
                elif text in ("未检测到", "未安装", "—"):
                    cell.setForeground(QColor("#797373"))
                if column == 1 and detected:
                    cell.setToolTip(found["path"])
                self.table.setItem(index, column, cell)
            button = self.button("更新" if installed else "安装", lambda n=name: self.start("install", [n]))
            button.setEnabled(idle and bool(account) and detected and bool(latest))
            action = QWidget(objectName="rowAction")
            action_layout = QHBoxLayout(action)
            action_layout.setContentsMargins(10, 0, 0, 0)
            action_layout.addWidget(button, 0, Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter)
            action_layout.addStretch()
            self.table.setItem(index, 4, QTableWidgetItem(""))
            self.table.setCellWidget(index, 4, action)

    def login(self):
        if self.job is not None:
            return
        previous = self.snapshot["account"] or self.manager.state.get("account", {})
        dialog = LoginDialog(previous, bool(previous), self)
        if dialog.exec() == QDialog.DialogCode.Accepted:
            self.start("login", *dialog.credentials())

    def logout(self):
        if self.job is not None:
            return
        answer = QMessageBox.question(self, "退出登录并卸载",
                                      "退出登录会卸载本机四个客户端中的 Swarm 插件。工作区和会话记录会保留。继续吗？")
        if answer == QMessageBox.StandardButton.Yes:
            self.start("logout")

    def toggle_startup(self, enabled):
        try:
            set_autostart(enabled)
        except OSError as exc:
            self.autostart.blockSignals(True)
            self.autostart.setChecked(not enabled)
            self.autostart.blockSignals(False)
            QMessageBox.warning(self, "开机启动设置失败", str(exc))

    def restart(self):
        names = [name for name in AGENTS if name in self.pending_restart]
        if names and self.job is None and QMessageBox.question(
            self, "重启客户端", "管理器会请求这些桌面客户端正常关闭。请先保存工作并等待正在执行的任务结束。继续吗？",
        ) == QMessageBox.StandardButton.Yes:
            self.start("restart", names)

    def auto_check(self):
        if self.manager.state.get("account") and self.job is None:
            self.start("check")

    def tray_activated(self, reason):
        if reason == QSystemTrayIcon.ActivationReason.DoubleClick:
            self.reveal()

    def reveal(self):
        self.showNormal()
        self.raise_()
        self.activateWindow()

    def quit(self):
        if self.job is not None:
            self.reveal()
            self.operation_status.setText("当前操作还在进行，完成后可退出程序。")
            return
        self.force_close = True
        self.tray.hide()
        QApplication.quit()

    def closeEvent(self, event):
        if not self.force_close and self.tray.isVisible():
            self.hide()
            event.ignore()
        elif self.job is not None:
            event.ignore()
        else:
            event.accept()


def main():
    if "--self-test" in sys.argv:
        os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    app = QApplication(sys.argv)
    app.setApplicationName("AgentSwarmManager")
    app.setStyle("Fusion")
    app.setFont(QFontDatabase.systemFont(QFontDatabase.SystemFont.FixedFont))
    app.setStyleSheet(STYLE)
    if getattr(sys, "frozen", False) and sys.platform == "win32":
        import ctypes
        ctypes.windll.kernel32.SetDllDirectoryW(None)
    if "--self-test" in sys.argv:
        from tempfile import TemporaryDirectory
        with TemporaryDirectory(prefix="swarm-ui-") as temp:
            root = Path(temp)
            app_icon = icon()
            window = Window(PluginManager(root, LocalPlugins(root)), app_icon)
            window.render()
            return 0 if window.table.rowCount() == 4 and not app_icon.pixmap(16, 16).isNull() else 1
    source = Path(sys.executable)
    if getattr(sys, "frozen", False) and (
        (sys.platform == "win32" and source.resolve() != installed_executable().resolve())
        or (sys.platform == "linux" and "--install-user" in sys.argv)
    ):
        try:
            install_manager(source, tray="--tray" in sys.argv)
        except (OSError, RuntimeError) as exc:
            QMessageBox.critical(None, "Agent Swarm Manager", f"安装失败\n{exc}")
            return 1
        return 0
    previous_dir = Path(QStandardPaths.writableLocation(QStandardPaths.StandardLocation.AppConfigLocation))
    previous_dir.mkdir(parents=True, exist_ok=True)
    lock = QLockFile(str(previous_dir / "manager.lock"))
    if not lock.tryLock(0):
        if "--tray" not in sys.argv:
            QMessageBox.information(None, "Agent Swarm", "管理器已运行，请双击托盘图标打开。")
        return 0
    app_icon = icon()
    app.setWindowIcon(app_icon)
    base = Path.home() / ".config/agent-swarm-manager"
    window = Window(PluginManager(base, LocalPlugins(), previous_dir / "plugins.json"), app_icon)
    app.setQuitOnLastWindowClosed(not window.tray.isVisible())
    if "--tray" not in sys.argv or not window.tray.isVisible():
        window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
