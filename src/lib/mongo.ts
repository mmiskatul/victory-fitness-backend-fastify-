import { ObjectId, type Collection, type Document, type Filter } from "mongodb";
import { AppError } from "./errors.js";
import { serialize } from "./serialize.js";

export const idFilter = (id: string): Filter<Document> =>
  (ObjectId.isValid(id)
    ? { _id: new ObjectId(id) }
    : { _id: id }) as Filter<Document>;

export const requiredDocument = async (
  collection: Collection<any>,
  id: string,
  label: string,
) => {
  const document = await collection.findOne(idFilter(id));
  if (!document) throw new AppError(404, `${label} not found`);
  return document;
};

export const pageQuery = (query: Record<string, unknown>) => {
  const page = Math.max(Number(query.page ?? 1), 1);
  const pageSize = Math.min(
    Math.max(Number(query.pageSize ?? query.page_size ?? query.limit ?? 20), 1),
    100,
  );
  return { page, pageSize, skip: (page - 1) * pageSize };
};

export async function paginated(
  collection: Collection<any>,
  filter: Filter<Document>,
  query: Record<string, unknown>,
  sort: Record<string, 1 | -1> = { created_at: -1 },
) {
  const { page, pageSize, skip } = pageQuery(query);
  const [documents, total] = await Promise.all([
    collection.find(filter).sort(sort).skip(skip).limit(pageSize).toArray(),
    collection.countDocuments(filter),
  ]);
  return {
    items: serialize(documents),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}
