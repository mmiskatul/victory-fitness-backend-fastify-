export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly detail: string,
    public readonly code?: string,
  ) {
    super(detail);
    this.name = "AppError";
  }
}

export const badRequest = (detail: string, code?: string): never => {
  throw new AppError(400, detail, code);
};

export const unauthorized = (detail = "Invalid access token"): never => {
  throw new AppError(401, detail);
};

export const forbidden = (detail: string): never => {
  throw new AppError(403, detail);
};

export const notFound = (detail: string): never => {
  throw new AppError(404, detail);
};
