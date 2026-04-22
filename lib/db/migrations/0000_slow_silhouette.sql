CREATE TABLE IF NOT EXISTS "users" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"telegram_id" text NOT NULL,
	"telegram_username" text,
	"telegram_name" text,
	"password" text NOT NULL,
	"password_hash" text,
	"plan" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"extended_api_key" text,
	"extended_stark_private_key" text,
	"extended_stark_public_key" text,
	"extended_account_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_telegram_id_unique" UNIQUE("telegram_id"),
	CONSTRAINT "users_password_unique" UNIQUE("password")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "strategies" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "strategies_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"market_index" integer NOT NULL,
	"market_symbol" text NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"is_running" boolean DEFAULT false NOT NULL,
	"dca_config" jsonb,
	"grid_config" jsonb,
	"total_orders" integer DEFAULT 0 NOT NULL,
	"successful_orders" integer DEFAULT 0 NOT NULL,
	"total_bought" numeric(20, 8) DEFAULT '0' NOT NULL,
	"total_sold" numeric(20, 8) DEFAULT '0' NOT NULL,
	"avg_buy_price" numeric(20, 8) DEFAULT '0' NOT NULL,
	"avg_sell_price" numeric(20, 8) DEFAULT '0' NOT NULL,
	"realized_pnl" numeric(20, 8) DEFAULT '0' NOT NULL,
	"exchange" text DEFAULT 'lighter' NOT NULL,
	"next_run_at" timestamp,
	"last_run_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_rerange_at" timestamp,
	"rerange_count_today" integer DEFAULT 0 NOT NULL,
	"rerange_count_date" text,
	"pending_rerange_at" timestamp,
	"pending_rerange_params" jsonb,
	"consecutive_out_of_range" integer DEFAULT 0 NOT NULL,
	"grid_last_level" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trades" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "trades_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer,
	"strategy_id" integer NOT NULL,
	"strategy_name" text NOT NULL,
	"market_index" integer NOT NULL,
	"market_symbol" text NOT NULL,
	"side" text NOT NULL,
	"size" numeric(20, 8) DEFAULT '0' NOT NULL,
	"price" numeric(20, 8) DEFAULT '0' NOT NULL,
	"fee" numeric(20, 8) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"order_hash" text,
	"client_order_index" bigint,
	"exchange" text DEFAULT 'lighter' NOT NULL,
	"error_message" text,
	"executed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bot_logs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "bot_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer,
	"strategy_id" integer,
	"strategy_name" text,
	"level" text DEFAULT 'info' NOT NULL,
	"message" text NOT NULL,
	"details" text,
	"exchange" text DEFAULT 'lighter',
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bot_config" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "bot_config_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pending_payments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "pending_payments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"donation_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"telegram_id" text NOT NULL,
	"telegram_username" text,
	"telegram_name" text NOT NULL,
	"plan" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"qr_string" text NOT NULL,
	"waiting_msg_id" integer,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pending_payments_donation_id_unique" UNIQUE("donation_id")
);
