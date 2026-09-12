import { Navigate, Route, Routes } from 'react-router-dom';
import { CreateWorkspacePage } from './pages/CreateWorkspacePage.js';
import { FilesPage, HistoryPage, SettingsPage } from './pages/PlaceholderPages.js';
import { TaskBoardPage } from './pages/TaskBoardPage.js';
import { TaskDetailPage } from './pages/TaskDetailPage.js';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<CreateWorkspacePage />} />
      <Route path="/w/:workspaceId" element={<TaskBoardPage />} />
      <Route path="/w/:workspaceId/tasks/:taskId" element={<TaskDetailPage />} />
      <Route path="/w/:workspaceId/files" element={<FilesPage />} />
      <Route path="/w/:workspaceId/history" element={<HistoryPage />} />
      <Route path="/w/:workspaceId/settings" element={<SettingsPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
