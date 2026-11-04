// SPDX-License-Identifier: MIT
#pragma once

#include "pcsx2/DebugTools/DebugServer.h"
#include "Debugger/DebuggerWindow.h"
#include "Debugger/Breakpoints/BreakpointModel.h"
#include "MainWindow.h"
#include "QtHost.h"
#include "MCPApplicationUI.h"
#include <QtCore/QBuffer>
#include <QtGui/QPixmap>
#include <QtWidgets/QApplication>
#include <QtWidgets/QAbstractItemView>
#include <QtCore/QSet>
#include <QtCore/QTimer>

namespace MCPApplicationCapture
{
	inline std::atomic_bool s_refreshQueued{false};
	inline void ScheduleBreakpointRefresh(int delay = 25)
	{
		if (!qApp || s_refreshQueued.exchange(true)) return;
		QTimer::singleShot(delay, qApp, []() {
			s_refreshQueued = false;
			QSet<BreakpointModel*> models, editing;
			// Never create a model: its constructor can load saved breakpoints.
			for (QWidget* widget : QApplication::allWidgets())
			{
				auto* view = qobject_cast<QAbstractItemView*>(widget);
				auto* model = view ? qobject_cast<BreakpointModel*>(view->model()) : nullptr;
				if (!model) continue;
				models.insert(model);
				if (view->viewport()->findChild<QWidget*>(QString(), Qt::FindDirectChildrenOnly)) editing.insert(model);
			}
			for (auto* model : models) if (!editing.contains(model)) model->refreshData();
			// Preserve active inline editing; retry even if editing is cancelled
			// without a subsequent native mutation/dataChanged notification.
			if (!editing.isEmpty()) ScheduleBreakpointRefresh(100);
		});
	}
	inline void Register()
	{
		DebugServer::SetBreakpointConfigurationChangedHandler([]() { ScheduleBreakpointRefresh(); });
		DebugServer::SetApplicationScreenshotHandler([](std::string target, uint32_t maxWidth, uint32_t maxHeight,
			DebugServer::ApplicationScreenshotCompletion complete) {
			QtHost::RunOnUIThread([target = std::move(target), maxWidth, maxHeight, complete = std::move(complete)]() mutable {
				DebugServer::ApplicationScreenshot result;
				QWidget* window = nullptr;
				if (target == "main") window = g_main_window;
				else if (target == "debugger")
				{
					// Discover an existing debugger. Never create/show/focus a window to capture it.
					for (QWidget* candidate : QApplication::topLevelWidgets())
						if (qobject_cast<DebuggerWindow*>(candidate) && candidate->isVisible()) { window = candidate; break; }
				}
				if (!window || !window->isVisible() || window->isMinimized()) result.error = "Requested PCSX2 window is not visible or is minimized";
				else if (window->width() * window->devicePixelRatioF() * window->height() * window->devicePixelRatioF() > 16777216.0)
					result.error = "Source window exceeds the 16 megapixel capture limit";
				else
				{
					QPixmap image = window->grab();
					if (image.width() > static_cast<int>(maxWidth) || image.height() > static_cast<int>(maxHeight))
						image = image.scaled(static_cast<int>(maxWidth), static_cast<int>(maxHeight), Qt::KeepAspectRatio, Qt::SmoothTransformation);
					QByteArray png; QBuffer buffer(&png);
					if (image.isNull() || !buffer.open(QIODevice::WriteOnly) || !image.save(&buffer, "PNG") || png.size() > 6 * 1024 * 1024)
						result.error = "Cannot encode application window within the 6 MiB PNG limit";
					else
					{
						result.width = image.width(); result.height = image.height();
						result.png.assign(png.begin(), png.end());
						result.title = window->windowTitle().left(512).toStdString();
					}
				}
				complete(std::move(result));
			});
		});
	}
}
