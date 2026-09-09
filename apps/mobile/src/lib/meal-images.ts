import type { ImageSourcePropType } from 'react-native';
import type { MealType } from './households';
import breakfastImage from '../../assets/meals/breakfast.jpg';
import dalTadkaImage from '../../assets/meals/dal-tadka.jpg';
import dinnerImage from '../../assets/meals/dinner.jpg';
import lunchImage from '../../assets/meals/lunch.jpg';

/**
 * Cooklink-owned, reviewed meal imagery.
 *
 * The broad meal-type photographs are intentionally labelled as serving
 * suggestions in the UI. Exact recipe photographs can opt in by normalized
 * name, while everything else receives an honest editorial fallback instead
 * of an unrelated stock image fetched at runtime.
 */
const BREAKFAST = breakfastImage;
const LUNCH = lunchImage;
const DINNER = dinnerImage;
const DAL_TADKA = dalTadkaImage;

const EXACT_IMAGES: Record<string, ImageSourcePropType> = {
  'dal tadka': DAL_TADKA,
  poha: breakfastImage,
  'paneer bhurji': dinnerImage,
};

const TYPE_IMAGES: Record<MealType, ImageSourcePropType> = {
  breakfast: BREAKFAST,
  lunch: LUNCH,
  dinner: DINNER,
};

export type MealImage = {
  source: ImageSourcePropType;
  representative: boolean;
};

export function mealImage(name: string, mealType: MealType): MealImage {
  const exact = EXACT_IMAGES[name.trim().toLowerCase()];
  if (exact) return { source: exact, representative: false };
  return { source: TYPE_IMAGES[mealType], representative: true };
}
