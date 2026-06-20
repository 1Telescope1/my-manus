export abstract class JSONParser {
  abstract invoke<T = unknown>(text: string, defaultValue?: T): Promise<T>;
}
