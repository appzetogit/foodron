import { useState, useCallback, useEffect } from 'react';
import { restaurantAPI } from "@food/api";

export const useUnder99Data = (zoneId) => {
  const [restaurants, setRestaurants] = useState([]);
  const [categories, setCategories] = useState([]);
  const [banner, setBanner] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [restRes] = await Promise.all([
        restaurantAPI.getUnder99Restaurants(zoneId ? { zoneId } : {}),
      ]);

      if (restRes.data?.success) setRestaurants(restRes.data.data.restaurants || []);
      // Old backend endpoints (categories + under-99 banner) removed.
      setCategories([]);
      setBanner(null);
    } catch (err) {
      console.error("Failed to fetch Under 99 data", err);
    } finally {
      setLoading(false);
    }
  }, [zoneId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { restaurants, categories, banner, loading };
};
