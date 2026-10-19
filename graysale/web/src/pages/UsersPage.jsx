import { useAuth } from '../api/AuthContext';
import UserManagementTable from '../components/UserManagementTable';

export default function UsersPage() {
  const { can } = useAuth();

  if (!can('users.manage')) {
    return (
      <div className="panel">
        <div className="empty-state">You do not have permission to manage users.</div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-hd">
        <div className="page-title">
          <h1>User Management</h1>
          <p>Manage login accounts, roles and access.</p>
        </div>
      </div>
      <UserManagementTable />
    </div>
  );
}
