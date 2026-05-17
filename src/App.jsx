import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Sessions from './pages/Sessions';
import SessionDetail from './pages/SessionDetail';
import NewSession from './pages/NewSession';
import QuickEntry from './pages/QuickEntry';
import Compare from './pages/Compare';
import Insights from './pages/Insights';
import EditSession from './pages/EditSession';
import CascadeAnalysis from './pages/CascadeAnalysis';
import Profiler from './pages/Profiler';
import HROverlay from './pages/HROverlay';
import LongTermTrends from './pages/LongTermTrends';
import Profile from './pages/Profile';
import CorrelationMatrix from './pages/CorrelationMatrix';
import VideoPlayer from './pages/VideoPlayer';
import Library from './pages/Library';
import Analytics from './pages/Analytics';
import PredictiveModeler from './pages/PredictiveModeler';
import JournalList from './pages/JournalList';

const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError, navigateToLogin } = useAuth();

  // Show loading spinner while checking app public settings or auth
  if (isLoadingPublicSettings || isLoadingAuth) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
      </div>
    );
  }

  // Handle authentication errors
  if (authError) {
    if (authError.type === 'user_not_registered') {
      return <UserNotRegisteredError />;
    } else if (authError.type === 'auth_required') {
      // Redirect to login automatically
      navigateToLogin();
      return null;
    }
  }

  // Render the main app
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/sessions" element={<Sessions />} />
        <Route path="/sessions/:id" element={<SessionDetail />} />
        <Route path="/sessions/:id/edit" element={<EditSession />} />
        <Route path="/new" element={<NewSession />} />
        <Route path="/new/quick" element={<QuickEntry />} />
        <Route path="/compare" element={<Compare />} />
        <Route path="/insights" element={<Insights />} />
        <Route path="/cascade" element={<CascadeAnalysis />} />
        <Route path="/profiler" element={<Profiler />} />
        <Route path="/overlay" element={<HROverlay />} />
        <Route path="/trends" element={<LongTermTrends />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/correlations" element={<CorrelationMatrix />} />
        <Route path="/video" element={<VideoPlayer />} />
        <Route path="/library" element={<Library />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route path="/modeler" element={<PredictiveModeler />} />
        <Route path="/journal" element={<JournalList />} />
        <Route path="*" element={<PageNotFound />} />
      </Route>
    </Routes>
  );
};


function App() {

  return (
    <AuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <Router>
          <AuthenticatedApp />
        </Router>
        <Toaster />
      </QueryClientProvider>
    </AuthProvider>
  )
}

export default App