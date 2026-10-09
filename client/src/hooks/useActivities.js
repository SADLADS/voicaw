import { useSyncExternalStore } from 'react';
import { activitiesOf, getActivitiesVersion, subscribeActivities } from '../utils/activities';

// Re-renders when anyone's activities change; returns `activitiesOf(userId)` (utils/activities.js).
export function useActivities() {
  useSyncExternalStore(subscribeActivities, getActivitiesVersion);
  return activitiesOf;
}
