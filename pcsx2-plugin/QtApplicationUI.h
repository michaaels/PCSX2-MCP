// SPDX-License-Identifier: MIT
#pragma once

#include "common/Console.h"
#include "Config.h"
#include "common/MCPRenderedUICapture.h"
#include <QtCore/QBuffer>
#include <QtCore/QDateTime>
#include <QtCore/QDeadlineTimer>
#include <QtCore/QElapsedTimer>
#include <QtCore/QJsonArray>
#include <QtCore/QJsonDocument>
#include <QtCore/QJsonObject>
#include <QtCore/QPersistentModelIndex>
#include <QtCore/QPointer>
#include <QtCore/QSet>
#include <QtCore/QTimer>
#include <QtCore/QUuid>
#include <QtGui/QAction>
#include <QtGui/QContextMenuEvent>
#include <QtGui/QKeyEvent>
#include <QtGui/QKeySequence>
#include <QtGui/QMouseEvent>
#include <QtGui/QPixmap>
#include <QtGui/QScreen>
#include <QtGui/QWindow>
#include <QtGui/QWheelEvent>
#include <QtNetwork/QTcpServer>
#include <QtNetwork/QTcpSocket>
#include <QtWidgets/QAbstractButton>
#include <QtWidgets/QAbstractItemView>
#include <QtWidgets/QAbstractSlider>
#include <QtWidgets/QApplication>
#include <QtWidgets/QComboBox>
#include <QtWidgets/QCheckBox>
#include <QtWidgets/QDoubleSpinBox>
#include <QtWidgets/QGroupBox>
#include <QtWidgets/QHeaderView>
#include <QtWidgets/QLabel>
#include <QtWidgets/QLineEdit>
#include <QtWidgets/QMenu>
#include <QtWidgets/QMenuBar>
#include <QtWidgets/QPlainTextEdit>
#include <QtWidgets/QSlider>
#include <QtWidgets/QSpinBox>
#include <QtWidgets/QTabBar>
#include <QtWidgets/QTabWidget>
#include <QtWidgets/QTextEdit>
#include <QtWidgets/QTreeView>
#include <algorithm>
#include <cmath>
#include <functional>
#include <memory>

// A frontend-only service: lifetime is QApplication, not a VM. All object/model
// access and input run on the UI thread. There is no global OS input injection.
namespace MCPApplicationUI
{
inline QString NewID() { return QUuid::createUuid().toString(QUuid::WithoutBraces); }
inline QJsonObject Failure(const QString& error) { return {{"ok", false}, {"error", error}}; }
inline qint64 Now() { return QDateTime::currentMSecsSinceEpoch(); }

struct Target
{
	QPointer<QObject> object;
	QPointer<QObject> root;
	QPointer<QAbstractItemView> view;
	QPersistentModelIndex index;
	QJsonObject observed;
	QList<QPointer<QAction>> ancestorActions;
	bool modelItem = false;
};

struct Peer
{
	QPointer<QTcpSocket> socket;
	QString snapshot;
	qint64 snapshotTime = 0;
	QElapsedTimer snapshotAge;
	QHash<QString, Target> targets;
	QHash<QString, QJsonObject> receipts;
	QStringList receiptOrder;
	QHash<QString, QPointer<QObject>> windows;
};

inline bool ManagedWindow(QWidget* window)
{
	return window && window->isWindow() && (window->windowType() == Qt::Window ||
		window->windowType() == Qt::Dialog || window->windowType() == Qt::Tool);
}

inline QString WindowState(QWidget* window)
{
	return window->isFullScreen() ? "fullscreen" : window->isMinimized() ? "minimized" : window->isMaximized() ? "maximized" : "normal";
}

inline QJsonArray Actions(QObject* object, bool item = false)
{
	QJsonArray actions;
	if (item) return {"select", "edit_text", "expand", "collapse", "mouse", "context_menu"};
	if (qobject_cast<QAction*>(object)) return {"trigger"};
	if (qobject_cast<QWindow*>(object)) return {"focus", "key", "mouse", "drag", "wheel", "close"};
	if (qobject_cast<QWidget*>(object)) actions = {"focus", "key", "mouse", "drag", "wheel", "context_menu"};
	if (auto* window = qobject_cast<QWidget*>(object); window && window->isWindow()) actions.append("close");
	if (ManagedWindow(qobject_cast<QWidget*>(object))) { actions.append("window_state"); actions.append("set_geometry"); }
	if (qobject_cast<QAbstractButton*>(object)) { actions.append("click"); actions.append("set_checked"); }
	if (qobject_cast<QGroupBox*>(object)) actions.append("set_checked");
	if (qobject_cast<QCheckBox*>(object)) actions.append("set_check_state");
	if (qobject_cast<QLineEdit*>(object) || qobject_cast<QPlainTextEdit*>(object) || qobject_cast<QTextEdit*>(object)) actions.append("set_text");
	if (qobject_cast<QComboBox*>(object) || qobject_cast<QTabBar*>(object) || qobject_cast<QTabWidget*>(object)) actions.append("select_index");
	if (qobject_cast<QSpinBox*>(object) || qobject_cast<QDoubleSpinBox*>(object) || qobject_cast<QAbstractSlider*>(object)) actions.append("set_value");
	return actions;
}

inline QJsonObject Describe(const Target& target)
{
	QObject* object = target.object;
	if (!object) return {};
	QJsonObject out{{"class", object->metaObject()->className()}, {"object_name", object->objectName().left(256)}, {"actions", Actions(object, target.modelItem)}};
	if (target.modelItem)
	{
		if (!target.view || !target.index.isValid() || target.view->model() != target.index.model()) return {};
		out["kind"] = "model_item";
		out["text"] = target.index.data().toString().left(512);
		out["row"] = target.index.row(); out["column"] = target.index.column();
		out["enabled"] = bool(target.index.flags() & Qt::ItemIsEnabled) && target.view->isEnabled();
		out["editable"] = bool(target.index.flags() & Qt::ItemIsEditable);
		const QRect rectangle = target.view->visualRect(target.index);
		out["visible"] = target.view->isVisible() && !rectangle.isEmpty() && target.view->viewport()->rect().intersects(rectangle);
		out["has_children"] = target.view->model()->hasChildren(target.index);
		if (auto* tree = qobject_cast<QTreeView*>(target.view.data())) out["expanded"] = tree->isExpanded(target.index);
		return out;
	}
	if (auto* action = qobject_cast<QAction*>(object))
	{
		out["kind"] = "action"; out["text"] = action->text().left(512);
		out["enabled"] = action->isEnabled(); out["visible"] = action->isVisible();
		for (const auto& parent : target.ancestorActions)
			if (!parent || !parent->isEnabled() || !parent->isVisible()) out["enabled"] = false;
		out["checkable"] = action->isCheckable(); out["checked"] = action->isChecked(); out["menu"] = action->menu() != nullptr;
		return out;
	}
	if (auto* surface = qobject_cast<QWindow*>(object))
	{
		out["kind"] = "surface"; out["enabled"] = true; out["visible"] = surface->isVisible();
		out["width"] = surface->width(); out["height"] = surface->height(); out["title"] = surface->title().left(512);
		out["input_scope"] = "window_local"; out["semantic_children"] = false;
	}
	if (auto* widget = qobject_cast<QWidget*>(object))
	{
		out["kind"] = "widget"; out["enabled"] = widget->isEnabled(); out["visible"] = widget->isVisible();
		out["width"] = widget->width(); out["height"] = widget->height();
		out["title"] = widget->windowTitle().left(512); out["tooltip"] = widget->toolTip().left(512);
		if (ManagedWindow(widget))
		{
			const QRect geometry = widget->geometry();
			out["window_state"] = WindowState(widget);
			out["geometry"] = QJsonObject{{"x", geometry.x()}, {"y", geometry.y()}, {"width", geometry.width()}, {"height", geometry.height()}};
			out["minimum_width"] = widget->minimumWidth(); out["minimum_height"] = widget->minimumHeight();
			out["maximum_width"] = widget->maximumWidth(); out["maximum_height"] = widget->maximumHeight();
			out["can_minimize"] = bool(widget->windowFlags() & Qt::WindowMinimizeButtonHint);
			out["can_maximize"] = bool(widget->windowFlags() & Qt::WindowMaximizeButtonHint);
		}
		if (auto* line = qobject_cast<QLineEdit*>(widget))
		{
			out["read_only"] = line->isReadOnly(); out["redacted"] = line->echoMode() != QLineEdit::Normal;
			if (line->echoMode() == QLineEdit::Normal) { out["text"] = line->text().left(512); out["text_truncated"] = line->text().size() > 512; }
		}
		else if (auto* button = qobject_cast<QAbstractButton*>(widget)) { out["text"] = button->text().left(512); out["checkable"] = button->isCheckable(); out["checked"] = button->isChecked(); }
		else if (auto* label = qobject_cast<QLabel*>(widget)) out["text"] = label->text().left(512);
		else if (auto* edit = qobject_cast<QPlainTextEdit*>(widget)) { out["text"] = edit->toPlainText().left(512); out["read_only"] = edit->isReadOnly(); }
		else if (auto* edit = qobject_cast<QTextEdit*>(widget)) { out["text"] = edit->toPlainText().left(512); out["read_only"] = edit->isReadOnly(); }
		if (auto* combo = qobject_cast<QComboBox*>(widget)) { out["current_index"] = combo->currentIndex(); out["text"] = combo->currentText().left(512); out["count"] = combo->count(); }
		if (auto* check = qobject_cast<QCheckBox*>(widget)) { out["check_state"] = check->checkState(); out["tristate"] = check->isTristate(); }
		if (auto* group = qobject_cast<QGroupBox*>(widget)) { out["text"] = group->title().left(512); out["checkable"] = group->isCheckable(); out["checked"] = group->isChecked(); }
		if (auto* tabs = qobject_cast<QTabBar*>(widget)) { out["current_index"] = tabs->currentIndex(); QJsonArray values; for (int i = 0; i < tabs->count() && i < 128; ++i) values.append(QJsonObject{{"index", i}, {"text", tabs->tabText(i)}, {"enabled", tabs->isTabEnabled(i)}}); out["tabs"] = values; }
		if (auto* tabs = qobject_cast<QTabWidget*>(widget)) { out["current_index"] = tabs->currentIndex(); out["count"] = tabs->count(); }
		if (auto* spin = qobject_cast<QSpinBox*>(widget)) { out["value"] = spin->value(); out["minimum"] = spin->minimum(); out["maximum"] = spin->maximum(); out["read_only"] = spin->isReadOnly(); }
		if (auto* spin = qobject_cast<QDoubleSpinBox*>(widget)) { out["value"] = spin->value(); out["minimum"] = spin->minimum(); out["maximum"] = spin->maximum(); out["read_only"] = spin->isReadOnly(); }
		if (auto* slider = qobject_cast<QAbstractSlider*>(widget)) { out["value"] = slider->value(); out["minimum"] = slider->minimum(); out["maximum"] = slider->maximum(); out["slider_down"] = slider->isSliderDown(); out["orientation"] = slider->orientation() == Qt::Horizontal ? "horizontal" : "vertical"; }
	}
	return out;
}

class Service final : public QObject
{
	QTcpServer m_server;
	QString m_id = NewID();
	int m_port;
	int m_clients = 0;
	bool m_originalQtDialogs = QCoreApplication::testAttribute(Qt::AA_DontUseNativeDialogs);
	struct Drag
	{
		QPointer<QObject> receiver, root;
		QPointer<QTcpSocket> socket;
		QPointer<QTimer> timer;
		QPoint start, end, last;
		Qt::MouseButton button;
		QElapsedTimer elapsed;
		QDeadlineTimer expires;
		int duration;
		bool held = false, finished = false;
		std::function<void(QString)> complete;
	};
	std::shared_ptr<Drag> m_drag;

	static QRect DragBounds(QObject* object)
	{
		if (auto* widget = qobject_cast<QWidget*>(object)) return widget->rect();
		if (auto* surface = qobject_cast<QWindow*>(object)) return QRect(QPoint(), surface->size());
		return {};
	}
	static void DragEvent(const std::shared_ptr<Drag>& drag, QEvent::Type type, Qt::MouseButtons held)
	{
		if (!drag->receiver) return;
		const QPoint global = qobject_cast<QWidget*>(drag->receiver.data()) ?
			qobject_cast<QWidget*>(drag->receiver.data())->mapToGlobal(drag->last) :
			qobject_cast<QWindow*>(drag->receiver.data())->mapToGlobal(drag->last);
		QMouseEvent event(type, drag->last, global, type == QEvent::MouseMove ? Qt::NoButton : drag->button, held, Qt::NoModifier);
		QCoreApplication::sendEvent(drag->receiver, &event);
	}
	void FinishDrag(const std::shared_ptr<Drag>& drag, const QString& error)
	{
		if (drag->finished) return;
		drag->finished = true;
		if (drag->timer) { drag->timer->stop(); drag->timer->deleteLater(); }
		// Always release to the original live receiver, even when hidden or when
		// its peer disconnects. No OS mouse grab or global pointer state is used.
		if (drag->held) { drag->held = false; DragEvent(drag, QEvent::MouseButtonRelease, Qt::NoButton); }
		if (m_drag == drag) m_drag.reset();
		drag->complete(error);
	}
	void StartDrag(QObject* receiver, QObject* root, const QPoint& start, const QPoint& end,
		Qt::MouseButton button, int duration, const QDeadlineTimer& expires,
		const std::shared_ptr<Peer>& peer, const std::function<void(QString)>& complete)
	{
		auto drag = std::make_shared<Drag>();
		drag->receiver = receiver; drag->root = root; drag->socket = peer->socket;
		drag->start = drag->last = start; drag->end = end; drag->button = button;
		drag->duration = duration; drag->expires = expires; drag->complete = complete;
		drag->timer = new QTimer(this); m_drag = drag;
		connect(drag->timer, &QTimer::timeout, this, [this, drag]() {
			if (drag->finished) return;
			if (!drag->socket || drag->socket->state() != QAbstractSocket::ConnectedState) { FinishDrag(drag, "Drag peer disconnected; button released"); return; }
			if (drag->expires.hasExpired()) { FinishDrag(drag, "Drag deadline expired; button released"); return; }
			if (!drag->receiver || !drag->root) { FinishDrag(drag, "Drag target or window was destroyed"); return; }
			auto* widget = qobject_cast<QWidget*>(drag->receiver.data());
			auto* rootWidget = qobject_cast<QWidget*>(drag->root.data());
			auto* surface = qobject_cast<QWindow*>(drag->receiver.data());
			auto* modal = QApplication::activeModalWidget();
			if ((widget && (!widget->isVisible() || !widget->isEnabled())) || (rootWidget && rootWidget->isMinimized()) ||
				(surface && (!surface->isVisible() || surface->windowState() == Qt::WindowMinimized)) ||
				(modal && modal != drag->root && (!rootWidget || !modal->isAncestorOf(rootWidget))) ||
				!DragBounds(drag->receiver).contains(drag->end)) { FinishDrag(drag, "Drag target became unavailable; button released"); return; }
			const qint64 elapsed = drag->elapsed.elapsed();
			const double fraction = std::min(1.0, static_cast<double>(elapsed) / drag->duration);
			drag->last = drag->start + QPoint(qRound((drag->end.x() - drag->start.x()) * fraction), qRound((drag->end.y() - drag->start.y()) * fraction));
			DragEvent(drag, QEvent::MouseMove, drag->button);
			if (elapsed >= drag->duration) FinishDrag(drag, {});
		});
		connect(peer->socket, &QTcpSocket::disconnected, drag->timer, [this, drag]() { FinishDrag(drag, "Drag peer disconnected; button released"); });
		drag->elapsed.start(); drag->timer->start(16);
		DragEvent(drag, QEvent::MouseMove, Qt::NoButton);
		if (!drag->finished && drag->receiver) { drag->held = true; DragEvent(drag, QEvent::MouseButtonPress, button); }
	}

	QJsonObject Identity() const
	{
		return {{"protocol_version", 1}, {"service_id", m_id}, {"process_id", QCoreApplication::applicationPid()},
			{"ui_port", m_port}, {"data_directory", QString::fromStdString(EmuFolders::DataRoot)}, {"scope", "pcsx2_qt_application"}};
	}
	void Reply(const std::shared_ptr<Peer>& peer, QJsonObject out)
	{
		if (!peer->socket) return;
		out["identity"] = Identity();
		QByteArray encoded = QJsonDocument(out).toJson(QJsonDocument::Compact);
		if (encoded.size() > 8 * 1024 * 1024) encoded = QJsonDocument(Failure("UI response exceeds 8 MiB; inspect a smaller window/subtree")).toJson(QJsonDocument::Compact);
		if (peer->socket->bytesToWrite() > 8 * 1024 * 1024) { peer->socket->abort(); return; }
		peer->socket->write(encoded + '\n');
	}
	QString WindowID(Peer& peer, QObject* widget)
	{
		for (auto it = peer.windows.begin(); it != peer.windows.end(); ++it) if (it.value() == widget) return it.key();
		const QString id = NewID(); peer.windows[id] = widget; return id;
	}
	QJsonObject Snapshot(Peer& peer, const QJsonObject& request)
	{
		for (auto it = peer.windows.begin(); it != peer.windows.end();) { if (!it.value()) it = peer.windows.erase(it); else ++it; }
		if (peer.windows.size() > 128) return Failure("Window inventory capacity reached; reconnect after closing unused windows");
		const int maxNodes = request["max_nodes"].toInt(2000), maxDepth = request["max_depth"].toInt(16), maxItems = request["max_items"].toInt(128);
		if (maxNodes < 1 || maxNodes > 5000 || maxDepth < 1 || maxDepth > 32 || maxItems < 0 || maxItems > 512) return Failure("Invalid snapshot bounds");
		QObject* root = nullptr;
		const QString wanted = request["window_id"].toString();
		if (!wanted.isEmpty()) { root = peer.windows.value(wanted); if (!root) return Failure("Unknown or destroyed window ID; refresh window inventory"); }
		if (!root) root = QApplication::activeModalWidget();
		if (!root) root = QApplication::activePopupWidget();
		if (!root) root = QApplication::activeWindow();
		QJsonArray windows;
		for (auto* window : QApplication::topLevelWidgets())
		{
			if (!window->isVisible()) continue;
			if (!root) root = window;
			windows.append(QJsonObject{{"window_id", WindowID(peer, window)}, {"class", window->metaObject()->className()},
				{"title", window->windowTitle().left(512)}, {"visible", true}, {"minimized", window->isMinimized()}, {"modal", window == QApplication::activeModalWidget()}});
		}
		// Rendered ImGui/Big Picture is a QWindow, not a widget tree. Expose its
		// actual surface independently; do not invent semantic ImGui controls.
		for (auto* surface : QGuiApplication::allWindows())
		{
			if (!surface->isVisible() || QByteArray(surface->metaObject()->className()) != "DisplaySurface") continue;
			windows.append(QJsonObject{{"window_id", WindowID(peer, surface)}, {"class", "DisplaySurface"},
				{"title", surface->title().left(512)}, {"visible", true}, {"minimized", surface->windowState() == Qt::WindowMinimized}, {"modal", false}, {"kind", "surface"}});
		}
		peer.targets.clear(); peer.snapshot = NewID(); peer.snapshotTime = Now(); peer.snapshotAge.start();
		QJsonArray controls;
		QSet<QObject*> seen;
		bool truncated = false;
		auto add = [&](Target target, const QString& parent) -> QString {
			if (controls.size() >= maxNodes) { truncated = true; return {}; }
			const QString id = "c" + QString::number(controls.size());
			target.observed = Describe(target);
			QJsonObject row = target.observed; row["id"] = id; row["parent_id"] = parent;
			if (auto* widget = qobject_cast<QWidget*>(target.object)) row["focused"] = widget->hasFocus();
			controls.append(row); peer.targets[id] = std::move(target); return id;
		};
		std::function<void(QAction*, const QString&, int, QList<QPointer<QAction>>)> action;
		action = [&](QAction* value, const QString& parent, int depth, QList<QPointer<QAction>> ancestors) {
			if (!value || seen.contains(value)) return;
			if (depth > maxDepth || controls.size() >= maxNodes) { truncated = true; return; }
			seen.insert(value); Target target; target.object = value; target.root = root; target.ancestorActions = ancestors;
			const QString id = add(target, parent);
			ancestors.append(value);
			if (value->menu()) for (auto* child : value->menu()->actions()) action(child, id, depth + 1, ancestors);
		};
		std::function<void(QWidget*, const QString&, int)> walk;
		walk = [&](QWidget* widget, const QString& parent, int depth) {
			if (!widget || seen.contains(widget)) return;
			if (depth > maxDepth || controls.size() >= maxNodes) { truncated = true; return; }
			seen.insert(widget); Target target; target.object = widget; target.root = root;
			const QString id = add(target, parent);
			for (auto* value : widget->actions()) action(value, id, depth + 1, {});
			if (auto* view = qobject_cast<QAbstractItemView*>(widget); view && view->isVisible() && !qobject_cast<QHeaderView*>(view) && view->model() && maxItems)
			{
				int items = 0;
				std::function<void(const QModelIndex&, const QString&, int)> rows;
				rows = [&](const QModelIndex& parentIndex, const QString& parentID, int level) {
					if (level > maxDepth) { truncated = true; return; }
					const int count = view->model()->rowCount(parentIndex), columns = std::min(view->model()->columnCount(parentIndex), 32);
					for (int row = 0; row < count; ++row)
					{
						for (int column = 0; column < columns; ++column)
						{
							if (items >= maxItems || controls.size() >= maxNodes) { truncated = true; return; }
							const QModelIndex index = view->model()->index(row, column, parentIndex);
							Target item; item.object = view; item.root = root; item.view = view; item.index = index; item.modelItem = true;
							const QString itemID = add(item, parentID); ++items;
							if (column == 0 && view->model()->hasChildren(index)) rows(index, itemID, level + 1);
						}
					}
				};
				rows(view->rootIndex(), id, depth + 1);
			}
			for (auto* child : widget->children())
				if (auto* childWidget = qobject_cast<QWidget*>(child); childWidget && !childWidget->isWindow()) walk(childWidget, id, depth + 1);
		};
		if (auto* widget = qobject_cast<QWidget*>(root)) walk(widget, {}, 0);
		else if (qobject_cast<QWindow*>(root)) { Target target; target.object = root; target.root = root; add(target, {}); }
		QJsonArray screens;
		for (auto* screen : QGuiApplication::screens())
		{
			if (screens.size() >= 16) break;
			const QRect area = screen->availableGeometry();
			screens.append(QJsonObject{{"index", static_cast<int>(screens.size())}, {"available_geometry", QJsonObject{{"x", area.x()}, {"y", area.y()}, {"width", area.width()}, {"height", area.height()}}}, {"device_pixel_ratio", screen->devicePixelRatio()}});
		}
		return {{"ok", true}, {"snapshot_id", peer.snapshot}, {"created_at_ms", peer.snapshotTime}, {"expires_at_ms", peer.snapshotTime + 120000},
			{"window_id", root ? WindowID(peer, root) : QString()}, {"windows", windows}, {"screens", screens}, {"controls", controls}, {"truncated", truncated}};
	}
	QString Execute(const Target& target, const QJsonObject& request, const QDeadlineTimer& expires,
		const std::shared_ptr<Peer>& peer, const std::function<void(QString)>& complete, bool& deferred)
	{
		if (m_drag) return "A local drag is running; wait for its release before another UI action";
		if (!target.object || !target.root) return "Target or window was destroyed";
		if (Describe(target) != target.observed) return "Target changed since snapshot; inspect again";
		if (!target.observed["enabled"].toBool()) return "Target is disabled";
		const QString operation = request["action"].toString();
		if (!Actions(target.object, target.modelItem).contains(operation)) return "Action unsupported for this control";
		QWidget* widget = qobject_cast<QWidget*>(target.object);
		QWidget* rootWidget = qobject_cast<QWidget*>(target.root.data());
		QWindow* surface = qobject_cast<QWindow*>(target.object.data());
		for (auto* line : target.root->findChildren<QLineEdit*>())
			if (line->isVisible() && line->echoMode() != QLineEdit::Normal) return "A redacted/authentication dialog requires user input";
		if (QWidget* modal = QApplication::activeModalWidget(); modal && modal != target.root && (!rootWidget || !modal->isAncestorOf(rootWidget))) return "A modal window blocks this target; inspect the modal";
		if ((widget && !widget->isVisible()) || (surface && (!surface->isVisible() || surface->windowState() == Qt::WindowMinimized))) return "Target is not visible or is minimized";
		if (rootWidget && rootWidget->isMinimized() && operation != "window_state" && operation != "close") return "Restore this minimized application window before using its controls";
		if (operation == "window_state")
		{
			const QString state = request["state"].toString();
			if (widget->isFullScreen()) return "Leave fullscreen through the application menu before changing window state";
			if (state == "normal") widget->showNormal();
			else if (state == "minimized" && widget->windowFlags().testFlag(Qt::WindowMinimizeButtonHint)) widget->showMinimized();
			else if (state == "maximized" && widget->windowFlags().testFlag(Qt::WindowMaximizeButtonHint)) widget->showMaximized();
			else return "Window state is unsupported or its application control is unavailable";
			return {};
		}
		if (operation == "set_geometry")
		{
			if (WindowState(widget) != "normal") return "Restore the application window to normal state before setting its geometry";
			const auto value = request["geometry"].toObject();
			for (const auto& name : {"x", "y", "width", "height"})
				if (!value[name].isDouble() || value[name].toDouble() != value[name].toInt()) return "Geometry requires integer x/y/width/height";
			const int x = value["x"].toInt(), y = value["y"].toInt(), width = value["width"].toInt(), height = value["height"].toInt();
			if (x < -32768 || x > 32768 || y < -32768 || y > 32768 || width < 160 || width > 4096 || height < 120 || height > 2160 ||
				width < widget->minimumWidth() || width > widget->maximumWidth() || height < widget->minimumHeight() || height > widget->maximumHeight()) return "Geometry exceeds application or service bounds";
			const QRect rectangle(x, y, width, height); bool fits = false;
			for (auto* screen : QGuiApplication::screens()) if (screen->availableGeometry().contains(rectangle)) { fits = true; break; }
			if (!fits) return "Geometry must fit within one available application screen area";
			widget->setGeometry(rectangle); return {};
		}
		if (operation == "trigger")
		{
			auto* action = qobject_cast<QAction*>(target.object);
			if (!action->isVisible() || action->isSeparator()) return "Action is hidden or is a separator";
			if (auto* popup = qobject_cast<QMenu*>(target.root.data()); popup && popup->isVisible() && popup->actions().contains(action))
			{
				// QMenu::exec returns the clicked action. QAction::trigger alone
				// does not close that nested loop or provide its selected result.
				const QPoint point = popup->actionGeometry(action).center();
				if (!popup->rect().contains(point)) return "Menu item is outside the visible popup";
				QPointer<QMenu> live = popup;
				QMouseEvent press(QEvent::MouseButtonPress, point, popup->mapToGlobal(point), Qt::LeftButton, Qt::LeftButton, Qt::NoModifier);
				QCoreApplication::sendEvent(popup, &press);
				if (live) { QMouseEvent release(QEvent::MouseButtonRelease, point, live->mapToGlobal(point), Qt::LeftButton, Qt::NoButton, Qt::NoModifier); QCoreApplication::sendEvent(live, &release); }
			}
			else if (auto* menu = action->menu()) menu->popup(rootWidget->mapToGlobal(QPoint(24, 48)));
			else action->trigger();
			return {};
		}
		if (operation == "click") { qobject_cast<QAbstractButton*>(widget)->click(); return {}; }
		if (operation == "close") { if (!(surface ? surface->close() : widget->close())) return "Window refused close"; return {}; }
		if (operation == "set_checked")
		{
			if (auto* group = qobject_cast<QGroupBox*>(widget))
			{
				if (!group->isCheckable() || !request["checked"].isBool()) return "Checkable group and boolean required";
				group->setChecked(request["checked"].toBool()); return {};
			}
			auto* button = qobject_cast<QAbstractButton*>(widget);
			if (!button->isCheckable() || !request["checked"].isBool()) return "set_checked requires a checkable button and boolean";
			if (button->isChecked() != request["checked"].toBool()) button->click();
			return {};
		}
		if (operation == "set_check_state")
		{
			auto* check = qobject_cast<QCheckBox*>(widget); const auto state = request["check_state"];
			const int value = state.toInt(-1);
			if (!state.isDouble() || state.toDouble() != value || value < 0 || value > 2 || (value == 1 && !check->isTristate())) return "Valid checkbox state (0/1/2) required";
			check->setCheckState(static_cast<Qt::CheckState>(value)); return {};
		}
		if (operation == "set_text")
		{
			if (!request["text"].isString() || request["text"].toString().toUtf8().size() > 16384) return "Text must be a string of at most 16384 UTF-8 bytes";
			const QString text = request["text"].toString();
			if (auto* line = qobject_cast<QLineEdit*>(widget)) { if (line->isReadOnly() || line->echoMode() != QLineEdit::Normal) return "Field is readonly or redacted"; line->setText(text); }
			else if (auto* edit = qobject_cast<QPlainTextEdit*>(widget)) { if (edit->isReadOnly()) return "Field is readonly"; edit->setPlainText(text); }
			else if (auto* edit = qobject_cast<QTextEdit*>(widget)) { if (edit->isReadOnly()) return "Field is readonly"; edit->setPlainText(text); }
			return {};
		}
		if (operation == "select_index")
		{
			const auto value = request["index"]; const int index = value.toInt(-1);
			if (!value.isDouble() || value.toDouble() != index || index < 0) return "A nonnegative integer index is required";
			if (auto* combo = qobject_cast<QComboBox*>(widget)) { if (index >= combo->count() || !(combo->model()->flags(combo->model()->index(index, combo->modelColumn(), combo->rootModelIndex())) & Qt::ItemIsEnabled)) return "Option is unavailable"; combo->setCurrentIndex(index); }
			else if (auto* tabs = qobject_cast<QTabBar*>(widget))
			{
				if (index >= tabs->count() || !tabs->isTabEnabled(index)) return "Tab is unavailable";
				const QPoint point = tabs->tabRect(index).center();
				if (!tabs->rect().contains(point)) return "Tab is outside the visible bar; navigate its scroll buttons first";
				// DockTabBar forwards tabBarClicked to its docking stack. Merely
				// assigning currentIndex can change the label without opening its page.
				QPointer<QTabBar> live = tabs;
				QMouseEvent press(QEvent::MouseButtonPress, point, tabs->mapToGlobal(point), Qt::LeftButton, Qt::LeftButton, Qt::NoModifier);
				QCoreApplication::sendEvent(tabs, &press);
				if (live) { QMouseEvent release(QEvent::MouseButtonRelease, point, live->mapToGlobal(point), Qt::LeftButton, Qt::NoButton, Qt::NoModifier); QCoreApplication::sendEvent(live, &release); }
			}
			else if (auto* tabs = qobject_cast<QTabWidget*>(widget)) { if (index >= tabs->count() || !tabs->isTabEnabled(index)) return "Tab is unavailable"; tabs->setCurrentIndex(index); }
			return {};
		}
		if (operation == "set_value")
		{
			const auto value = request["value"]; const double number = value.toDouble();
			if (!value.isDouble() || !std::isfinite(number) || number < target.observed["minimum"].toDouble() || number > target.observed["maximum"].toDouble()) return "Numeric value is outside the control range";
			if (auto* spin = qobject_cast<QSpinBox*>(widget)) { if (spin->isReadOnly() || number != std::floor(number)) return "Integer writable spinbox required"; spin->setValue(static_cast<int>(number)); }
			else if (auto* spin = qobject_cast<QDoubleSpinBox*>(widget)) { if (spin->isReadOnly()) return "Spinbox is readonly"; spin->setValue(number); }
			else if (auto* slider = qobject_cast<QAbstractSlider*>(widget)) { if (number != std::floor(number)) return "Integer slider value required"; slider->setValue(static_cast<int>(number)); }
			return {};
		}
		if (operation == "focus") { if (surface) surface->requestActivate(); else widget->setFocus(Qt::OtherFocusReason); return {}; }
		if (operation == "key")
		{
			const QString key = request["key"].toString();
			if (key.isEmpty() || key.size() > 64) return "Key sequence must be 1-64 characters";
			const auto sequence = QKeySequence::fromString(key, QKeySequence::PortableText);
			if (sequence.count() != 1 || sequence[0].key() == Qt::Key_unknown || (sequence[0].keyboardModifiers() & Qt::MetaModifier)) return "One Qt key chord without Meta is required";
			const QString text = request["text"].toString(); if (text.size() > 32) return "Key text exceeds 32 characters";
			if (widget) widget->setFocus(Qt::OtherFocusReason);
			QPointer<QObject> live = target.object;
			QKeyEvent press(QEvent::KeyPress, sequence[0].key(), sequence[0].keyboardModifiers(), text);
			QCoreApplication::sendEvent(live, &press);
			if (live) { QKeyEvent release(QEvent::KeyRelease, sequence[0].key(), sequence[0].keyboardModifiers(), text); QCoreApplication::sendEvent(live, &release); }
			return {};
		}
		QPoint point;
		if (target.modelItem)
		{
			auto* view = target.view.data(); const QModelIndex index = target.index;
			if (operation == "select") { view->setCurrentIndex(index); view->selectionModel()->select(index, QItemSelectionModel::ClearAndSelect); return {}; }
			if (operation == "edit_text") { if (!(index.flags() & Qt::ItemIsEditable) || !request["text"].isString() || request["text"].toString().toUtf8().size() > 16384) return "Editable model item and bounded text required"; if (!view->model()->setData(index, request["text"].toString(), Qt::EditRole)) return "Model refused the edit"; return {}; }
			if (operation == "expand" || operation == "collapse") { auto* tree = qobject_cast<QTreeView*>(view); if (!tree) return "Tree view required"; tree->setExpanded(index, operation == "expand"); return {}; }
			if (operation == "context_menu")
			{
				// A real right-click selects its item before the context event.
				view->setCurrentIndex(index);
				view->selectionModel()->select(index, QItemSelectionModel::ClearAndSelect);
			}
			const QRect rectangle = view->visualRect(index);
			if (rectangle.isEmpty() || !view->viewport()->rect().intersects(rectangle)) return "Model item is outside the viewport; navigate/expand first";
			widget = view->viewport(); point = rectangle.center();
		}
		else
		{
			const auto x = request["x"], y = request["y"];
			if (!x.isDouble() || !y.isDouble() || x.toDouble() != x.toInt() || y.toDouble() != y.toInt()) return "Integer widget-local x/y are required";
			point = QPoint(x.toInt(), y.toInt());
		}
		const QRect bounds = surface ? QRect(QPoint(), surface->size()) : widget ? widget->rect() : QRect();
		if (!bounds.contains(point)) return "Point is outside the target control";
		const QPoint global = surface ? surface->mapToGlobal(point) : widget->mapToGlobal(point);
		QObject* receiver = surface ? static_cast<QObject*>(surface) : widget;
		if (operation == "wheel")
		{
			const auto dx = request["delta_x"], dy = request["delta_y"];
			if ((!dx.isUndefined() && (!dx.isDouble() || dx.toDouble() != dx.toInt())) || !dy.isDouble() || dy.toDouble() != dy.toInt() || std::abs(dx.toDouble()) > 1200 || std::abs(dy.toDouble()) > 1200) return "Bounded integer wheel deltas required";
			QWheelEvent wheel(point, global, QPoint(), QPoint(dx.toInt(), dy.toInt()), Qt::NoButton, Qt::NoModifier, Qt::NoScrollPhase, false);
			QCoreApplication::sendEvent(receiver, &wheel); return {};
		}
		if (operation == "context_menu") { QContextMenuEvent event(QContextMenuEvent::Mouse, point, widget->mapToGlobal(point)); QCoreApplication::sendEvent(widget, &event); return {}; }
		const QString buttonName = request["button"].toString("left");
		if (buttonName != "left" && buttonName != "right" && buttonName != "middle") return "Unknown mouse button";
		const Qt::MouseButton button = buttonName == "right" ? Qt::RightButton : buttonName == "middle" ? Qt::MiddleButton : Qt::LeftButton;
		if (operation == "drag")
		{
			const auto x = request["end_x"], y = request["end_y"], durationValue = request["duration_ms"];
			const int duration = durationValue.toInt();
			if (!x.isDouble() || !y.isDouble() || x.toDouble() != x.toInt() || y.toDouble() != y.toInt() ||
				!durationValue.isDouble() || durationValue.toDouble() != duration || duration < 50 || duration > 1000) return "Drag requires integer end_x/end_y and duration_ms (50-1000)";
			const QPoint end(x.toInt(), y.toInt());
			if (!bounds.contains(end)) return "Drag endpoint is outside the target control";
			if (expires.remainingTime() < duration + 50) return "Drag duration exceeds its remaining action deadline";
			deferred = true;
			StartDrag(receiver, target.root, point, end, button, duration, expires, peer, complete);
			return {};
		}
		QPointer<QObject> live = receiver;
		QMouseEvent move(QEvent::MouseMove, point, global, Qt::NoButton, Qt::NoButton, Qt::NoModifier);
		QCoreApplication::sendEvent(receiver, &move);
		auto event = [&](QEvent::Type type, Qt::MouseButtons held) { if (live) { QMouseEvent input(type, point, global, button, held, Qt::NoModifier); QCoreApplication::sendEvent(live, &input); } };
		event(QEvent::MouseButtonPress, button); event(QEvent::MouseButtonRelease, Qt::NoButton);
		if (request["double_click"].toBool()) { event(QEvent::MouseButtonDblClick, button); event(QEvent::MouseButtonRelease, Qt::NoButton); }
		return {};
	}
	void Handle(const std::shared_ptr<Peer>& peer, const QJsonObject& request)
	{
		const QString command = request["cmd"].toString();
		if (command == "ui_status") { Reply(peer, {{"ok", true}, {"features", QJsonArray{"qt_ui_snapshot", "qt_ui_actions", "qt_ui_screenshot", "ui_without_vm", "qt_render_surface_input", "qt_local_drag"}}}); return; }
		if (request["expected_service_id"].toString() != m_id || request["expected_process_id"].toDouble(-1) != QCoreApplication::applicationPid()) { Reply(peer, Failure("UI process/service identity mismatch")); return; }
		if (command == "ui_snapshot") { Reply(peer, Snapshot(*peer, request)); return; }
		if (command == "ui_action_status") { const QString id = request["action_id"].toString(); Reply(peer, peer->receipts.contains(id) ? QJsonObject{{"ok", true}, {"action", peer->receipts[id]}} : Failure("Unknown action receipt on this connection")); return; }
		const QString snapshot = request["snapshot_id"].toString();
		if (snapshot.isEmpty() || snapshot != peer->snapshot || !peer->snapshotAge.isValid() || peer->snapshotAge.elapsed() > 120000) { Reply(peer, Failure("Unknown, consumed or expired UI snapshot; inspect again")); return; }
		if (command == "ui_screenshot")
		{
			QObject* object = peer->windows.value(request["window_id"].toString());
			QWidget* window = qobject_cast<QWidget*>(object);
			QWindow* surface = qobject_cast<QWindow*>(object);
			const int width = request["width"].toInt(1920), height = request["height"].toInt(1440);
			if ((!window && !surface) || (window && (!window->isVisible() || window->isMinimized())) || (surface && (!surface->isVisible() || surface->windowState() == Qt::WindowMinimized)) || width < 1 || width > 2560 || height < 1 || height > 1600) { Reply(peer, Failure("Visible window and valid capture bounds required")); return; }
			const double dpr = surface ? surface->devicePixelRatio() : window->devicePixelRatioF();
			const QSize size = surface ? surface->size() : window->size();
			if (size.width() * dpr * size.height() * dpr > 16777216.0) { Reply(peer, Failure("Window exceeds the 16 megapixel capture limit")); return; }
			if (surface)
			{
				const QPointer<QWindow> live = surface;
				auto done = std::make_shared<bool>(false);
				const auto requestCapture = MCPRenderedUI::Queue(reinterpret_cast<void*>(surface->winId()), [this, peer, live, done, request, width, height](MCPRenderedUI::Frame frame) mutable {
					QTimer::singleShot(0, this, [this, peer, live, done, request, width, height, frame = std::move(frame)]() {
						if (*done) return; *done = true;
						if (!peer->socket || !live) return;
						if (!frame.error.empty()) { Reply(peer, Failure(QString::fromStdString(frame.error))); return; }
						QImage image(reinterpret_cast<const uchar*>(frame.rgba.data()), frame.width, frame.height, QImage::Format_RGBA8888);
						if (image.width() > width || image.height() > height) image = image.scaled(width, height, Qt::KeepAspectRatio, Qt::SmoothTransformation);
						QByteArray png; QBuffer buffer(&png);
						if (image.isNull() || !buffer.open(QIODevice::WriteOnly) || !image.save(&buffer, "PNG") || png.size() > 4 * 1024 * 1024) { Reply(peer, Failure("Cannot encode bounded rendered UI PNG")); return; }
						Reply(peer, {{"ok", true}, {"window_id", request["window_id"]}, {"width", image.width()}, {"height", image.height()}, {"mime_type", "image/png"}, {"capture_method", "d3d11_present_buffer_with_imgui"}, {"data", QString::fromLatin1(png.toBase64())}});
					});
				});
				if (!requestCapture) { Reply(peer, Failure("A rendered UI capture is already pending")); return; }
				QTimer::singleShot(4500, this, [this, peer, done, requestCapture]() {
					if (*done) return; *done = true; requestCapture->cancelled = true;
					Reply(peer, Failure("Rendered UI capture timed out: requires active D3D11 RGBA8/BGRA8 presentation; no desktop fallback"));
				});
				return;
			}
			QPixmap image = window->grab();
			if (image.width() > width || image.height() > height) image = image.scaled(width, height, Qt::KeepAspectRatio, Qt::SmoothTransformation);
			QByteArray png; QBuffer buffer(&png);
			if (image.isNull() || !buffer.open(QIODevice::WriteOnly) || !image.save(&buffer, "PNG") || png.size() > 4 * 1024 * 1024) { Reply(peer, Failure("Cannot encode a bounded application PNG")); return; }
			Reply(peer, {{"ok", true}, {"window_id", request["window_id"]}, {"width", image.width()}, {"height", image.height()}, {"mime_type", "image/png"}, {"capture_method", "qt_widget_render"}, {"data", QString::fromLatin1(png.toBase64())}}); return;
		}
		if (command != "ui_action") { Reply(peer, Failure("Unknown UI command")); return; }
		const QString id = request["control_id"].toString();
		const auto deadlineValue = request["deadline_ms"];
		const double deadlineNumber = deadlineValue.toDouble();
		if (!deadlineValue.isDouble() || !std::isfinite(deadlineNumber) || deadlineNumber < Now() || deadlineNumber > Now() + 5000) { Reply(peer, Failure("Action deadline must be current and within 5000 ms")); return; }
		const qint64 deadline = static_cast<qint64>(deadlineNumber);
		const QDeadlineTimer expires(std::max<qint64>(0, deadline - Now()));
		if (!peer->targets.contains(id)) { Reply(peer, Failure("Unknown control ID in this snapshot")); return; }
		int pending = 0; for (const auto& receipt : peer->receipts) if (receipt["state"] == "queued" || receipt["state"] == "running") ++pending;
		if (pending >= 8 || (peer->receiptOrder.size() >= 128 && (peer->receipts[peer->receiptOrder.front()]["state"] == "queued" || peer->receipts[peer->receiptOrder.front()]["state"] == "running"))) { Reply(peer, Failure("UI action receipt capacity reached")); return; }
		while (peer->receiptOrder.size() >= 128) peer->receipts.remove(peer->receiptOrder.takeFirst());
		const Target target = peer->targets[id]; const QString operation = NewID();
		peer->snapshot.clear(); peer->targets.clear();
		peer->receipts[operation] = {{"action_id", operation}, {"state", "queued"}, {"action", request["action"]}, {"queued_at_ms", Now()}};
		peer->receiptOrder.append(operation);
		Reply(peer, {{"ok", true}, {"action", peer->receipts[operation]}});
		QTimer::singleShot(0, this, [this, peer, target, request, operation, expires]() {
			if (!peer->socket || peer->socket->state() != QAbstractSocket::ConnectedState || expires.hasExpired()) { peer->receipts[operation]["state"] = "expired"; return; }
			peer->receipts[operation]["state"] = "running"; peer->receipts[operation]["started_at_ms"] = Now();
			const auto complete = [peer, operation](const QString& error) {
				peer->receipts[operation]["state"] = error.isEmpty() ? "completed" : "failed";
				peer->receipts[operation]["finished_at_ms"] = Now();
				if (auto* popup = QApplication::activePopupWidget()) peer->receipts[operation]["active_popup_class"] = popup->metaObject()->className();
				if (auto* modal = QApplication::activeModalWidget()) peer->receipts[operation]["active_modal_class"] = modal->metaObject()->className();
				if (!error.isEmpty()) peer->receipts[operation]["error"] = error;
			};
			bool deferred = false;
			const QString error = Execute(target, request, expires, peer, complete, deferred);
			if (!deferred) complete(error);
		});
	}
public:
	explicit Service(int port) : QObject(qApp), m_server(this), m_port(port)
	{
		QObject::connect(&m_server, &QTcpServer::newConnection, this, [this]() {
			while (m_server.hasPendingConnections())
			{
				QTcpSocket* socket = m_server.nextPendingConnection();
				if (m_clients >= 8) { socket->abort(); socket->deleteLater(); continue; }
				if (++m_clients == 1) QCoreApplication::setAttribute(Qt::AA_DontUseNativeDialogs, true);
				socket->setReadBufferSize(131072);
				auto peer = std::make_shared<Peer>(); peer->socket = socket;
				QObject::connect(socket, &QTcpSocket::disconnected, this, [this, socket, peer]() { if (--m_clients == 0) QCoreApplication::setAttribute(Qt::AA_DontUseNativeDialogs, m_originalQtDialogs); peer->targets.clear(); peer->windows.clear(); socket->deleteLater(); });
				QObject::connect(socket, &QTcpSocket::readyRead, this, [this, peer]() {
					if (!peer->socket) return;
					if (peer->socket->bytesAvailable() >= 131072) { peer->socket->abort(); return; }
					int count = 0;
					while (peer->socket && peer->socket->canReadLine())
					{
						if (++count > 32) { peer->socket->abort(); return; }
						const QByteArray line = peer->socket->readLine(65538);
						if (!line.endsWith('\n') || line.size() > 65536) { peer->socket->abort(); return; }
						QJsonParseError error; const auto document = QJsonDocument::fromJson(line, &error);
						if (error.error != QJsonParseError::NoError || !document.isObject()) { Reply(peer, Failure("Expected one bounded JSON object per line")); continue; }
						Handle(peer, document.object());
					}
				});
			}
		});
		if (!m_server.listen(QHostAddress::LocalHost, static_cast<quint16>(port))) Console.Error("MCP Qt UI service cannot listen on 127.0.0.1:%d", port);
		else Console.WriteLn("MCP Qt UI service listening on 127.0.0.1:%d", port);
	}
};

inline void Register()
{
	QTimer::singleShot(0, qApp, []() {
		static QPointer<Service> service;
		if (service) return;
		bool valid = true;
		const QByteArray explicitPort = qgetenv("PCSX2_UI_PORT");
		int port = 21513;
		if (!explicitPort.isEmpty()) port = explicitPort.toInt(&valid);
		if (!valid || port < 1 || port > 65535) { Console.Error("Invalid PCSX2_UI_PORT; Qt UI service disabled"); return; }
		service = new Service(port);
	});
}
}
