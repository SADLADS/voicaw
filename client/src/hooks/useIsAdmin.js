import { useEffect, useState } from 'react';
import api from '../utils/api';

// Whether you're a global admin, for Settings' Admin and Reports pages: the server answers
// GET /admin only for admins (403 otherwise). AdminSettings loads the same itself when shown.
export function useIsAdmin() {
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    let live = true;
    api.get('/admin').then(
      ({ data }) => { if (live && data?.settings) setIsAdmin(true); },
      () => {}
    );
    return () => { live = false; };
  }, []);
  return isAdmin;
}
