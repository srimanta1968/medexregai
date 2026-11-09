import { Route, Routes } from 'react-router-dom';
import HomePage from './pages/HomePage';
import NotFoundPage from './pages/NotFoundPage';

/** Top-level routes. Sign-in, sign-up and the app shell arrive with feature F0.1/F0.2. */
export default function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
