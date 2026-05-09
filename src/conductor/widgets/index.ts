import { registerWidget } from "./registry";
import { TaskListDefinition } from "./TaskListWidget";
import { NotePadDefinition } from "./NotePadWidget";
import { PomodoroDefinition } from "./PomodoroWidget";
import { NewsBoardDefinition } from "./NewsBoardWidget";

registerWidget(TaskListDefinition);
registerWidget(NotePadDefinition);
registerWidget(PomodoroDefinition);
registerWidget(NewsBoardDefinition);
