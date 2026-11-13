// SPDX-License-Identifier: MIT
#pragma once
#include "Debugger/DebuggerWindow.h"
#include "Debugger/Docking/DockManager.h"
#include "Debugger/Docking/DockViews.h"
#include <kddockwidgets/core/DockWidget.h>
#include <kddockwidgets/core/DockRegistry.h>
#include <kddockwidgets/core/Group.h>
#include <QtCore/QJsonArray>
#include <QtCore/QJsonObject>
#include <QtWidgets/QApplication>
#include <algorithm>

// Semantic operations on the actual debugger docking controllers, UI thread only.
namespace MCPApplicationDocking
{
inline ::DockWidget* View(QObject* object) { return qobject_cast<::DockWidget*>(object); }
inline QWidget* Window(::DockWidget* view) { return view->QWidget::window(); }
inline bool Locked() { return !g_debugger_window || g_debugger_window->dockManager().isLayoutLocked(); }
inline QJsonObject Describe(QObject* object)
{
 auto* view = View(object); if (!view) return {};
 auto* dock = view->dockWidget();
 QJsonArray group;
 if (view->group()) for (auto* member : view->group()->dockWidgets())
 {
  if (group.size() >= 128) break;
  group.append(member->uniqueName().left(256));
 }
 return {{"unique_name", dock->uniqueName().left(256)}, {"title", dock->title().left(512)}, {"floating", dock->isFloating()},
  {"in_main_window", dock->isInMainWindow()}, {"in_floating_window", dock->floatingWindow() != nullptr},
  {"has_previous_location", dock->hasPreviousDockedLocation()}, {"layout_locked", Locked()}, {"group", group}};
}
inline QList<::DockWidget*> List()
{
 QList<::DockWidget*> result;
 for (auto* widget : QApplication::allWidgets())
  if (auto* dock = View(widget); dock && Window(dock)->isVisible()) result.append(dock);
 std::sort(result.begin(), result.end(), [](auto* a, auto* b) { return a->uniqueName() < b->uniqueName(); });
 return result;
}
inline QString SetFloating(::DockWidget* view, bool floating)
{
 if (Locked()) return "Debugger layout is locked; unlock it through its application control first";
 auto* dock = view->dockWidget();
 if (floating && dock->isFloating()) return {};
 if (!floating && dock->isInMainWindow()) return {};
 if (!floating && (!dock->isFloating() || !dock->hasPreviousDockedLocation()))
  return "Previous location is unavailable for this panel; dock relative to an inspected target";
 if (!dock->setFloating(floating)) return "Docking controller refused the floating state";
 if (floating ? !dock->isFloating() : !dock->isInMainWindow()) return "Docking controller did not reach the requested floating state";
 return {};
}
inline QString Dock(::DockWidget* source, ::DockWidget* destination, const QString& location)
{
 if (Locked()) return "Debugger layout is locked; unlock it through its application control first";
 if (source == destination) return "A panel cannot dock relative to itself";
 auto* from = source->dockWidget(); auto* to = destination->dockWidget();
 using namespace KDDockWidgets;
 if ((from->options() & DockWidgetOption_NotDockable) ||
     (to->options() & (DockWidgetOption_NotDockable | DockWidgetOption_NoDrops)) ||
     !source->group() || !destination->group() || !destination->group()->isDockable())
  return "Docking is unavailable for these panels";
 if (!DockRegistry::self()->affinitiesMatch(from->affinities(), to->affinities())) return "Docking panel affinities differ";
 if (location == "tab") to->addDockWidgetAsTab(from);
 else
 {
  Location side;
  if (location == "left") side = Location_OnLeft;
  else if (location == "right") side = Location_OnRight;
  else if (location == "top") side = Location_OnTop;
  else if (location == "bottom") side = Location_OnBottom;
  else return "Dock location must be tab, left, right, top or bottom";
  to->addDockWidgetToContainingWindow(from, side, to);
 }
 if (Window(source) != Window(destination) || !source->group() ||
     ((source->group() == destination->group()) != (location == "tab")))
  return "Docking controller did not reach the requested placement; inspect before another action";
 return {};
}
}
