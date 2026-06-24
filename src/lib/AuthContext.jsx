import React, { createContext, useState, useContext, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { discoverSarahApiBase, isSarahNativeShell } from '@/lib/mobileApiBase';
import { incrementLifecycleMountCount, recordPwaLifecycleEvent } from '@/lib/pwaLifecycleDiagnostics';

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [isLoadingPublicSettings, setIsLoadingPublicSettings] = useState(true);
  const [authError, setAuthError] = useState(null);
  const [appPublicSettings, setAppPublicSettings] = useState(null); // Contains only { id, public_settings }
  const [bootStatus, setBootStatus] = useState({
    message: 'Starting local cockpit...',
    detail: '',
  });

  useEffect(() => {
    incrementLifecycleMountCount('auth_provider');
    checkAppState();
  }, []);

  const checkAppState = async () => {
    try {
      recordPwaLifecycleEvent('auth_initialization_start');
      setIsLoadingPublicSettings(true);
      setAuthError(null);
      setAppPublicSettings({ id: 'local', public_settings: {} });
      setIsLoadingPublicSettings(false);
      if (isSarahNativeShell()) {
        setBootStatus({ message: 'Finding Sarah server...', detail: '' });
        const discovery = await discoverSarahApiBase({
          timeoutMs: 2600,
          onAttempt: (base) => setBootStatus({
            message: 'Finding Sarah server...',
            detail: base,
          }),
        });
        setBootStatus({
          message: 'Connected to Sarah server',
          detail: discovery.base,
        });
      }
      await checkUserAuth();
      recordPwaLifecycleEvent('auth_initialization_complete');
    } catch (error) {
      console.error('Unexpected error:', error);
      setAuthError({
        type: 'unknown',
        message: error.message || 'An unexpected error occurred'
      });
      setBootStatus({
        message: 'Phone cannot reach desktop Sarah',
        detail: error.message || 'Internet can still work while this local desktop API path is unavailable. Check Wi-Fi/Tailscale and whether the desktop Sarah app is running.',
      });
      setIsLoadingPublicSettings(false);
      setIsLoadingAuth(false);
    }
  };

  const checkUserAuth = async () => {
    try {
      // Now check if the user is authenticated
      recordPwaLifecycleEvent('auth_refresh_start');
      setIsLoadingAuth(true);
      const currentUser = await base44.auth.me();
      setUser(currentUser);
      setIsAuthenticated(true);
      setIsLoadingAuth(false);
      recordPwaLifecycleEvent('auth_refresh_success');
    } catch (error) {
      console.error('User auth check failed:', error);
      setIsLoadingAuth(false);
      setIsAuthenticated(false);
      recordPwaLifecycleEvent('auth_refresh_failed', {
        status: error?.status || null,
        message: error?.message || String(error),
      });
      
      // If user auth fails, it might be an expired token
      if (error.status === 401 || error.status === 403) {
        setAuthError({
          type: 'auth_required',
          message: 'Authentication required'
        });
      }
    }
  };

  const logout = (shouldRedirect = true) => {
    setUser(null);
    setIsAuthenticated(false);
    
    if (shouldRedirect) {
      // Use the SDK's logout method which handles token cleanup and redirect
      base44.auth.logout(window.location.href);
    } else {
      // Just remove the token without redirect
      base44.auth.logout();
    }
  };

  const navigateToLogin = () => {
    // Use the SDK's redirectToLogin method
    base44.auth.redirectToLogin(window.location.href);
  };

  return (
    <AuthContext.Provider value={{ 
      user, 
      isAuthenticated, 
      isLoadingAuth,
      isLoadingPublicSettings,
      authError,
      appPublicSettings,
      logout,
      navigateToLogin,
      checkAppState,
      bootStatus,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
