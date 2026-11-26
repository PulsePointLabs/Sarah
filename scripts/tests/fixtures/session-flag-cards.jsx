import React from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import SessionCard from '/src/components/SessionCard.jsx';
import RecentSessionsWidget from '/src/components/dashboard/RecentSessionsWidget.jsx';
import '/src/index.css';
const session={id:'flags',date:'2026-11-25',is_favorite:0,no_climax:0,is_quick_entry:0,duration_minutes:0,satisfaction:0,intensity:0};
createRoot(document.getElementById('root')).render(<BrowserRouter><SessionCard session={session}/><RecentSessionsWidget sessions={[session]}/></BrowserRouter>);
