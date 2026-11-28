import './resizableVideoTelemetry.css';
import MonitorTelemetryDashboard from './MonitorTelemetryDashboard.jsx';

export default function ResizableVideoTelemetry({enabled,dashboard=false,children}) {
  return dashboard||enabled?<MonitorTelemetryDashboard dashboard={dashboard}>{children}</MonitorTelemetryDashboard>:children;
}
