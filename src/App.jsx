import { useEffect, useRef } from 'react';
import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import Layout from './components/Layout';
import { SarahSplash } from '@/components/SarahBrand';
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
import ProfileQA from './pages/ProfileQA';
import AIAnnotation from './pages/AIAnnotation';
import CorrelationMatrix from './pages/CorrelationMatrix';
import VideoPlayer from './pages/VideoPlayer';
import SessionReviewPlayer from './pages/SessionReviewPlayer';
import MotionLab from './pages/MotionLab';
import Library from './pages/Library';
import Analytics from './pages/Analytics';
import PredictiveModeler from './pages/PredictiveModeler';
import JournalList from './pages/JournalList';
import LiveCapture from './pages/LiveCapture';
import SettingsStatus from './pages/SettingsStatus';
import BodyExploration from './pages/BodyExploration';
import BodyExplorationDetail from './pages/BodyExplorationDetail';
import NewBodyExploration from './pages/NewBodyExploration';
import { incrementLifecycleMountCount, recordPwaLifecycleEvent } from '@/lib/pwaLifecycleDiagnostics';

const AuthenticatedApp = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const {
    isLoadingAuth,
    isLoadingPublicSettings,
    authError,
    bootStatus,
    navigateToLogin,
  } = useAuth();
  const bootScreenVisibleRef = useRef(null);

  useEffect(() => {
    incrementLifecycleMountCount('router_tree');
  }, []);

  useEffect(() => {
    let listener = null;
    let active = true;

    import('@capacitor/app')
      .then(({ App: CapacitorApp }) => {
        if (!active || !CapacitorApp?.addListener) return;
        return CapacitorApp.addListener('backButton', async ({ canGoBack } = {}) => {
          if (document.fullscreenElement) {
            await document.exitFullscreen?.();
            return;
          }

          const activeElement = document.activeElement;
          if (activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeElement.tagName)) {
            activeElement.blur();
            return;
          }

          if (location.pathname === '/video' || location.pathname === '/review-player') {
            if (canGoBack || window.history.length > 1) navigate(-1);
            else navigate('/sessions');
            return;
          }

          if (canGoBack || window.history.length > 1) {
            navigate(-1);
            return;
          }

          CapacitorApp.exitApp?.();
        });
      })
      .then((handle) => {
        listener = handle;
      })
      .catch(() => {});

    return () => {
      active = false;
      listener?.remove?.();
    };
  }, [location.pathname, navigate]);

  const bootScreenVisible = Boolean(isLoadingPublicSettings || isLoadingAuth);

  useEffect(() => {
    if (bootScreenVisibleRef.current === bootScreenVisible) return;
    bootScreenVisibleRef.current = bootScreenVisible;
    recordPwaLifecycleEvent(bootScreenVisible ? 'boot_screen_entry' : 'boot_screen_exit', {
      isLoadingPublicSettings,
      isLoadingAuth,
    });
  }, [bootScreenVisible, isLoadingAuth, isLoadingPublicSettings]);

  // Show loading spinner while checking app public settings or auth
  if (bootScreenVisible) {
    return (
      <SarahSplash
        message={bootStatus?.message}
        detail={bootStatus?.detail}
      />
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
    } else {
      return (
        <SarahSplash
          message={bootStatus?.message || 'Could not start Sarah'}
          detail={bootStatus?.detail || authError.message}
          error
        />
      );
    }
  }

  // Render the main app
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/sessions" element={<Sessions />} />
        <Route path="/sessions/:id" element={<SessionDetail />} />
        <Route path="/sessions/:id/ai-annotation" element={<AIAnnotation />} />
        <Route path="/sessions/:id/edit" element={<EditSession />} />
        <Route path="/new" element={<NewSession />} />
        <Route path="/new/quick" element={<QuickEntry />} />
        <Route path="/exploration" element={<BodyExploration />} />
        <Route path="/exploration/new" element={<NewBodyExploration />} />
        <Route path="/exploration/:id" element={<BodyExplorationDetail />} />
        <Route path="/exploration/:id/edit" element={<NewBodyExploration />} />
        <Route path="/compare" element={<Compare />} />
        <Route path="/insights" element={<Insights />} />
        <Route path="/cascade" element={<CascadeAnalysis />} />
        <Route path="/profiler" element={<Profiler />} />
        <Route path="/overlay" element={<HROverlay />} />
        <Route path="/trends" element={<LongTermTrends />} />
        <Route path="/profile-qa" element={<ProfileQA />} />
        <Route path="/ai-annotation" element={<AIAnnotation />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/correlations" element={<CorrelationMatrix />} />
        <Route path="/video" element={<VideoPlayer />} />
        <Route path="/review-player" element={<SessionReviewPlayer />} />
        <Route path="/motion-lab" element={<MotionLab />} />
        <Route path="/library" element={<Library />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route path="/modeler" element={<PredictiveModeler />} />
        <Route path="/journal" element={<JournalList />} />
        <Route path="/capture" element={<LiveCapture />} />
        <Route path="/settings" element={<SettingsStatus />} />
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
