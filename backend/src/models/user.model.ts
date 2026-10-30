import mongoose, { type HydratedDocument, type Model, type Types } from "mongoose";

export type UserRole = "owner";

export interface UserFields {
  name: string;
  email: string;
  passwordHash: string;
  businessId: Types.ObjectId;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new mongoose.Schema<UserFields>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "A valid email address is required."],
    },
    passwordHash: {
      type: String,
      required: true,
      select: false,
      match: [
        /^\$2[aby]\$(?:0[4-9]|[12]\d|3[01])\$[./A-Za-z0-9]{53}$/,
        "passwordHash must contain a bcrypt hash.",
      ],
    },
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
    },
    role: {
      type: String,
      enum: ["owner"],
      default: "owner",
      required: true,
    },
  },
  { timestamps: true },
);

userSchema.index({ email: 1 }, { unique: true, name: "users_email_unique" });
userSchema.index({ businessId: 1 }, { unique: true, name: "users_business_id_unique" });

export type UserDocument = HydratedDocument<UserFields>;

export const User =
  (mongoose.models.User as Model<UserFields> | undefined) ??
  mongoose.model<UserFields>("User", userSchema);
