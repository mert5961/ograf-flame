"""
OGraf Studio -> Autodesk Flame 2026 bridge.

Adds "OGraf > Render OGraf Graphic..." to the Media Panel right-click menu and the
Flame main menu. Picks an OGraf Studio template (.ogs set, exported .ograf.zip, or
extracted package folder), lets you edit its fields, renders it offline in headless
Chrome to a transparent PNG sequence (renderFrames.mjs), then imports the clip into
the selected reel / library / folder.

Install: run ./install.sh (links this folder into /opt/Autodesk/shared/python).
Then restart Flame or rescan hooks
(Flame menu > Python > Rescan Python Hooks).
"""

import json
import os
import re
import shutil
import time

import flame
from PySide6 import QtCore, QtGui, QtWidgets

HERE = os.path.dirname(os.path.realpath(__file__))
RENDERER = os.path.join(HERE, "renderFrames.mjs")
OUTPUT_ROOT = os.environ.get(
    "OGRAF_FLAME_OUTPUT", os.path.expanduser("~/Movies/OGraf Renders")
)
SETTINGS = QtCore.QSettings("OGrafStudio", "FlameBridge")
DESTINATION_TYPES = ("PyReel", "PyLibrary", "PyFolder", "PyReelGroup", "PyDesktop")


def find_node():
    candidates = [
        os.environ.get("OGRAF_NODE"),
        shutil.which("node"),
        os.path.expanduser("~/.local/bin/node"),
        "/usr/local/bin/node",
        "/opt/homebrew/bin/node",
    ]
    nvm = os.path.expanduser("~/.nvm/versions/node")
    if os.path.isdir(nvm):
        candidates += [os.path.join(nvm, v, "bin/node") for v in sorted(os.listdir(nvm), reverse=True)]
    for path in candidates:
        if path and os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return None


def node_env(node):
    """Flame's environment has a minimal PATH; put Node's folder (and Homebrew/usr/local) on it."""
    env = dict(os.environ)
    extra = [os.path.dirname(node), "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"]
    env["PATH"] = os.pathsep.join(extra + [env.get("PATH", "")])
    return env


def default_destination():
    desktop = flame.projects.current_project.current_workspace.desktop
    for group in desktop.reel_groups:
        if group.reels:
            return group.reels[0]
    return desktop


def import_sequence(result, destination):
    pattern = os.path.join(result["out"], result["pattern"])
    try:
        clips = flame.import_clips(pattern, destination)
    except Exception:
        clips = None
    if not clips:
        # Fall back to importing the folder; Flame groups the numbered frames into one clip.
        clips = flame.import_clips(result["out"], destination)
    return clips


class RenderDialog(QtWidgets.QDialog):
    def __init__(self, destination, parent=None):
        super().__init__(parent)
        self.destination = destination
        self.node = find_node()
        self.description = None
        self.field_widgets = {}
        self.process = None
        self.result = None

        self.setWindowTitle("Render OGraf Graphic")
        self.setMinimumWidth(620)

        layout = QtWidgets.QVBoxLayout(self)
        form = QtWidgets.QFormLayout()
        layout.addLayout(form)

        row = QtWidgets.QHBoxLayout()
        self.input_edit = QtWidgets.QLineEdit(SETTINGS.value("lastInput", ""))
        browse = QtWidgets.QPushButton("Browse...")
        browse.clicked.connect(self.browse)
        row.addWidget(self.input_edit)
        row.addWidget(browse)
        form.addRow("Template", row)
        self.input_edit.editingFinished.connect(lambda: self.describe())

        self.template_combo = QtWidgets.QComboBox()
        self.template_combo.currentTextChanged.connect(lambda _t: self.describe(keep_template=True))
        form.addRow("Template in set", self.template_combo)

        self.fps_spin = QtWidgets.QDoubleSpinBox()
        self.fps_spin.setRange(1, 120)
        self.fps_spin.setDecimals(3)
        self.hold_spin = QtWidgets.QDoubleSpinBox()
        self.hold_spin.setRange(0, 3600)
        self.hold_spin.setValue(float(SETTINGS.value("hold", 5)))
        self.hold_spin.setSuffix(" s")
        self.stop_check = QtWidgets.QCheckBox("Play the Stop (out) animation")
        self.stop_check.setChecked(SETTINGS.value("stop", "true") == "true")
        self.start_spin = QtWidgets.QSpinBox()
        self.start_spin.setRange(0, 9999999)
        self.start_spin.setValue(int(SETTINGS.value("startFrame", 1001)))
        self.size_label = QtWidgets.QLabel("-")
        form.addRow("Resolution", self.size_label)
        form.addRow("Frame rate", self.fps_spin)
        form.addRow("Hold after Play", self.hold_spin)
        form.addRow("", self.stop_check)
        form.addRow("Start frame", self.start_spin)

        self.fields_box = QtWidgets.QGroupBox("Fields")
        self.fields_form = QtWidgets.QFormLayout(self.fields_box)
        scroll = QtWidgets.QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setWidget(self.fields_box)
        scroll.setMinimumHeight(260)
        layout.addWidget(scroll)

        self.status = QtWidgets.QLabel("")
        self.status.setWordWrap(True)
        self.progress = QtWidgets.QProgressBar()
        self.progress.setVisible(False)
        layout.addWidget(self.status)
        layout.addWidget(self.progress)

        buttons = QtWidgets.QDialogButtonBox()
        self.render_button = buttons.addButton("Render && Import", QtWidgets.QDialogButtonBox.AcceptRole)
        self.cancel_button = buttons.addButton(QtWidgets.QDialogButtonBox.Cancel)
        self.render_button.clicked.connect(self.render)
        self.cancel_button.clicked.connect(self.cancel)
        layout.addWidget(buttons)

        dest_name = getattr(getattr(destination, "name", None), "get_value", lambda: None)()
        if dest_name:
            self.status.setText("Imports into: %s" % dest_name)
        if not self.node:
            self.set_error("Node.js 22+ not found. Install it or set OGRAF_NODE to its path.")
        elif self.input_edit.text():
            self.describe()

    # ---------- helpers ----------
    def set_error(self, message):
        self.status.setText('<span style="color:#e5534b">%s</span>' % message.replace("<", "&lt;"))

    def browse(self):
        start = os.path.dirname(self.input_edit.text()) or os.path.expanduser("~")
        path, _ = QtWidgets.QFileDialog.getOpenFileName(
            self,
            "Choose an OGraf template",
            start,
            "OGraf templates (*.ogs *.zip *.ograf.json);;All files (*)",
        )
        if path:
            if path.endswith(".ograf.json"):
                path = os.path.dirname(path)
            self.input_edit.setText(path)
            self.template_combo.blockSignals(True)
            self.template_combo.clear()
            self.template_combo.blockSignals(False)
            self.describe()

    def run_node(self, args):
        import subprocess

        proc = subprocess.run(
            [self.node, RENDERER] + args,
            capture_output=True,
            text=True,
            timeout=120,
            env=node_env(self.node),
        )
        line = (proc.stdout.strip().splitlines() or ["{}"])[-1]
        try:
            return json.loads(line)
        except ValueError:
            return {"ok": False, "error": (proc.stderr or proc.stdout).strip()[-500:]}

    def describe(self, keep_template=False):
        path = self.input_edit.text().strip()
        if not path or not self.node:
            return
        args = ["--input", path, "--describe"]
        template = self.template_combo.currentText() if keep_template else ""
        if template:
            args += ["--template", template]
        QtWidgets.QApplication.setOverrideCursor(QtCore.Qt.WaitCursor)
        try:
            info = self.run_node(args)
        finally:
            QtWidgets.QApplication.restoreOverrideCursor()
        if not info.get("ok"):
            self.set_error(info.get("error", "Could not read the template."))
            return
        self.description = info

        templates = info.get("templates") or []
        self.template_combo.blockSignals(True)
        if [self.template_combo.itemText(i) for i in range(self.template_combo.count())] != templates:
            self.template_combo.clear()
            self.template_combo.addItems(templates)
        self.template_combo.setCurrentText(info["name"] if templates else "")
        self.template_combo.setEnabled(bool(templates))
        self.template_combo.blockSignals(False)

        self.size_label.setText("%d x %d" % (info["width"], info["height"]))
        self.fps_spin.setValue(float(info["fps"]))
        self.rebuild_fields(info.get("fields", []))
        if not info.get("supportsNonRealTime"):
            self.set_error(
                "This package is real-time only. Re-export it from OGraf Studio with the "
                "Non-real-time or Dual profile, or pick the .ogs file instead."
            )
        else:
            self.status.setText("%s - %d field(s)" % (info["name"], len(info.get("fields", []))))

    def rebuild_fields(self, fields):
        while self.fields_form.rowCount():
            self.fields_form.removeRow(0)
        self.field_widgets = {}
        for field in fields:
            default = field.get("default")
            kind = field.get("type")
            if field.get("enum"):
                widget = QtWidgets.QComboBox()
                widget.addItems([str(v) for v in field["enum"]])
                if default is not None:
                    widget.setCurrentText(str(default))
            elif kind == "boolean":
                widget = QtWidgets.QCheckBox()
                widget.setChecked(bool(default))
            elif kind in ("number", "integer"):
                widget = QtWidgets.QDoubleSpinBox()
                widget.setRange(-1e9, 1e9)
                widget.setDecimals(0 if kind == "integer" else 3)
                widget.setValue(float(default or 0))
            elif kind == "string":
                widget = QtWidgets.QLineEdit("" if default is None else str(default))
            else:
                # Arrays/objects: edit as JSON.
                widget = QtWidgets.QPlainTextEdit(json.dumps(default, indent=1, ensure_ascii=False))
                widget.setFixedHeight(80)
            widget.setProperty("fieldType", kind)
            self.field_widgets[field["id"]] = widget
            self.fields_form.addRow(field.get("label") or field["id"], widget)

    def field_values(self):
        values = {}
        for key, widget in self.field_widgets.items():
            kind = widget.property("fieldType")
            if isinstance(widget, QtWidgets.QComboBox):
                values[key] = widget.currentText()
            elif isinstance(widget, QtWidgets.QCheckBox):
                values[key] = widget.isChecked()
            elif isinstance(widget, QtWidgets.QDoubleSpinBox):
                values[key] = int(widget.value()) if kind == "integer" else widget.value()
            elif isinstance(widget, QtWidgets.QLineEdit):
                values[key] = widget.text()
            else:
                try:
                    values[key] = json.loads(widget.toPlainText())
                except ValueError:
                    raise ValueError('Field "%s" is not valid JSON.' % key)
        return values

    # ---------- render ----------
    def render(self):
        if not self.description or self.process:
            return
        try:
            data = self.field_values()
        except ValueError as error:
            self.set_error(str(error))
            return

        name = self.description["name"]
        safe = re.sub(r"[^\w.-]+", "_", name).strip("_") or "ograf"
        out_dir = os.path.join(OUTPUT_ROOT, "%s_%s" % (safe, time.strftime("%Y%m%d_%H%M%S")))
        os.makedirs(out_dir, exist_ok=True)
        data_file = os.path.join(out_dir, "fields.json")
        with open(data_file, "w") as handle:
            json.dump(data, handle, indent=2, ensure_ascii=False)

        args = [
            RENDERER,
            "--input", self.input_edit.text().strip(),
            "--out", out_dir,
            "--data", "@" + data_file,
            "--fps", str(self.fps_spin.value()),
            "--hold", str(self.hold_spin.value()),
            "--start-frame", str(self.start_spin.value()),
            "--name", safe,
        ]
        if self.template_combo.isEnabled() and self.template_combo.currentText():
            args += ["--template", self.template_combo.currentText()]
        if not self.stop_check.isChecked():
            args.append("--no-stop")

        SETTINGS.setValue("lastInput", self.input_edit.text().strip())
        SETTINGS.setValue("hold", self.hold_spin.value())
        SETTINGS.setValue("stop", "true" if self.stop_check.isChecked() else "false")
        SETTINGS.setValue("startFrame", self.start_spin.value())

        self.stdout = ""
        self.process = QtCore.QProcess(self)
        environment = QtCore.QProcessEnvironment()
        for key, value in node_env(self.node).items():
            environment.insert(key, value)
        self.process.setProcessEnvironment(environment)
        self.process.readyReadStandardError.connect(self.on_stderr)
        self.process.readyReadStandardOutput.connect(self.on_stdout)
        self.process.finished.connect(self.on_finished)
        self.render_button.setEnabled(False)
        self.progress.setVisible(True)
        self.progress.setRange(0, 0)
        self.status.setText("Rendering %s ..." % name)
        self.process.start(self.node, args)

    def on_stderr(self):
        text = bytes(self.process.readAllStandardError()).decode("utf-8", "replace")
        for done, total in re.findall(r"PROGRESS (\d+) (\d+)", text):
            self.progress.setRange(0, int(total))
            self.progress.setValue(int(done))

    def on_stdout(self):
        self.stdout += bytes(self.process.readAllStandardOutput()).decode("utf-8", "replace")

    def on_finished(self, code, _status):
        self.process = None
        self.progress.setVisible(False)
        self.render_button.setEnabled(True)
        try:
            result = json.loads(self.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            result = {"ok": False, "error": "Renderer exited with code %s." % code}
        if not result.get("ok"):
            self.set_error(result.get("error", "Render failed."))
            return
        try:
            import_sequence(result, self.destination)
        except Exception as error:  # noqa: BLE001 - surface Flame API errors to the user
            self.set_error("Rendered to %s but the import failed: %s" % (result["out"], error))
            return
        self.result = result
        self.accept()

    def cancel(self):
        if self.process:
            self.process.kill()
            self.process = None
            self.status.setText("Render cancelled.")
            self.render_button.setEnabled(True)
            self.progress.setVisible(False)
            return
        self.reject()


def open_dialog(destination):
    parent = QtWidgets.QApplication.activeWindow()
    dialog = RenderDialog(destination, parent)
    dialog.exec()
    if dialog.result:
        r = dialog.result
        print(
            "[OGraf] Imported %s: %d frames %dx%d @ %s fps in %ss from %s"
            % (r["name"], r["frames"], r["width"], r["height"], r["fps"], r["seconds"], r["out"])
        )


def _from_media_panel(selection):
    for item in selection:
        if type(item).__name__ in DESTINATION_TYPES:
            return open_dialog(item)
    open_dialog(default_destination())


def _is_destination(selection):
    return any(type(item).__name__ in DESTINATION_TYPES for item in selection)


def get_media_panel_custom_ui_actions():
    return [
        {
            "name": "OGraf",
            "actions": [
                {
                    "name": "Render OGraf Graphic...",
                    "isVisible": _is_destination,
                    "execute": _from_media_panel,
                    "minimumVersion": "2026",
                }
            ],
        }
    ]


def get_main_menu_custom_ui_actions():
    return [
        {
            "name": "OGraf",
            "actions": [
                {
                    "name": "Render OGraf Graphic...",
                    "execute": lambda _selection: open_dialog(default_destination()),
                    "minimumVersion": "2026",
                }
            ],
        }
    ]
